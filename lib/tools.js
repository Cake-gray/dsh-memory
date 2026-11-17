/**
 * 模型可调用的记忆工具。
 *
 * 六个工具，覆盖“写、查、改、删、量、导出”：
 *   memory_save    保存一条记忆（自动去重、按上限裁剪）
 *   memory_search  检索（返回带 score 的结构化结果）
 *   memory_update  就地修正（内容/类型/标签/重要度/过期时间）
 *   memory_forget  永久删除（只在明确要求时使用）
 *   memory_stats   规模、类型分布、热门标签、数据库大小
 *   memory_export  导出 Markdown / JSON 备份到 <DSH_HOME>/memory/exports
 *
 * 所有输出都是“规范 JSON 值”，人类可读文本放在 render 里；
 * 参数由 defineTool 统一校验，execute 内再做业务约束（长度、范围、id 是否存在）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { exportFile } from './export.js'
import { KINDS, KIND_LABELS } from './search.js'
import { isoOf, truncate } from './text.js'

const MAX_TAGS = 12
const MAX_TAG_LEN = 32

/** 业务错误：统一带上中文提示。 */
function fail(message) {
  throw new Error(message)
}

/** 归一化标签列表。 */
function cleanTags(tags) {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) fail('tags 必须是字符串数组')
  const out = []
  for (const raw of tags) {
    if (typeof raw !== 'string') fail('tags 里只能放字符串')
    const tag = raw.trim().toLowerCase()
    if (tag === '') continue
    if (tag.length > MAX_TAG_LEN) fail(`单个标签最长 ${MAX_TAG_LEN} 个字符：${tag.slice(0, MAX_TAG_LEN)}…`)
    if (!out.includes(tag)) out.push(tag)
  }
  if (out.length > MAX_TAGS) fail(`标签最多 ${MAX_TAGS} 个`)
  return out
}

/** 校验并返回重要度（1-5）。 */
function cleanImportance(value, fallback = 3) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > 5) fail('importance 必须是 1-5 的整数')
  return value
}

/** 日期文本。 */
function day(ms) {
  return isoOf(ms) || '未知'
}

/** 单行记忆摘要。 */
function line(row, max = 240) {
  const tags = row.tags.length > 0 ? ` #${row.tags.join(' #')}` : ''
  const kind = KIND_LABELS[row.kind] ?? row.kind
  return `#${row.id} [${kind}·重要度${row.importance}] ${truncate(row.content.replace(/\s+/gu, ' '), max)}${tags}`
}

/** 统一的分页/查询参数校验。 */
function cleanLimit(value, fallback, max = 50) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > max) fail(`limit 必须是 1-${max} 的整数`)
  return value
}

/**
 * 构造全部工具定义。
 * @param {{getStore:() => import('./store.js').MemoryStore, cfg: ReturnType<import('./config.js').liveConfig>}} deps
 */
export function createTools({ getStore, cfg }) {
  const disabled = () => !cfg.enabled
  const guard = () => {
    if (disabled()) fail('长期记忆插件已被设置页关闭（enabled=false），请先在插件设置里开启。')
  }

  const saveTool = defineTool({
    name: 'memory_save',
    description:
      '把一条值得跨会话保留的信息写入本机长期记忆库（SQLite）。适合保存：用户偏好、重要决定、可复用经验、未完成的待办、稳定事实。不要把临时闲聊、一次性查询结果、密码/验证码/密钥写进去。若不确定是否已有相同记忆，先调用 memory_search 查一下，避免重复。',
    parameters: {
      content: { type: 'string', required: true, description: '记忆正文。要自包含：写清对象、结论或约定，必要时带时间。最长受插件设置 maxContentChars 约束。' },
      kind: { type: 'string', enum: KINDS, description: '类型：fact(事实) / preference(偏好) / decision(决定) / lesson(经验) / todo(待办) / event(事件)。省略时用插件设置里的 defaultKind。' },
      tags: { type: 'array', items: { type: 'string' }, description: '短标签，最多 12 个，例如 ["饮食","周末"]。用于过滤与加权。' },
      importance: { type: 'integer', description: '重要度 1-5，默认 3。用户明确强调的长期偏好可给 4-5。' },
      expiresInDays: { type: 'number', description: '多少天后自动过期（用于待办/临时约定），必须大于 0。省略表示永不过期。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', required: true },
          duplicate: { type: 'boolean', required: true },
          kind: { type: 'string', required: true },
          importance: { type: 'integer', required: true },
          tags: { type: 'array', items: { type: 'string' }, required: true },
          total: { type: 'integer', required: true },
        },
      },
      render(args, value) {
        const label = KIND_LABELS[value.kind] ?? value.kind
        const tags = value.tags.length > 0 ? `，标签 #${value.tags.join(' #')}` : ''
        if (value.duplicate) return [{ type: 'text', text: `已存在相同记忆 #${value.id}（${label}）。已合并标签${tags}并保留更高重要度 ${value.importance}。当前记忆库共 ${value.total} 条。` }]
        return [{ type: 'text', text: `已记住 #${value.id}（${label}，重要度 ${value.importance}${tags}）。当前记忆库共 ${value.total} 条。` }]
      },
    },
    async execute(args, exec) {
      guard()
      if (exec?.signal?.aborted) fail('调用已取消')
      const content = String(args.content ?? '').trim()
      if (content === '') fail('content 不能为空')
      if (content.length > cfg.maxContentChars) fail(`content 太长（${content.length} 字符），上限 ${cfg.maxContentChars}；请压缩或拆成多条。`)
      const kind = args.kind ?? cfg.defaultKind
      if (!KINDS.includes(kind)) fail(`未知 kind：${kind}`)
      const tags = cleanTags(args.tags)
      const importance = cleanImportance(args.importance)
      let expiresAt = null
      if (args.expiresInDays !== undefined) {
        if (typeof args.expiresInDays !== 'number' || !Number.isFinite(args.expiresInDays) || args.expiresInDays <= 0 || args.expiresInDays > 3650) {
          fail('expiresInDays 必须是大于 0 且不超过 3650 的数字（要立即删除请用 memory_forget）')
        }
        expiresAt = Date.now() + Math.round(args.expiresInDays * 86_400_000)
      }
      const store = getStore()
      const saved = store.save({ content, kind, tags, importance, expiresAt, dedupe: cfg.dedupe, source: 'tool' })
      store.prune(cfg.maxMemories)
      return {
        id: saved.id,
        duplicate: saved.duplicate,
        kind: saved.kind,
        importance: saved.importance,
        tags: saved.tags,
        total: store.count(),
      }
    },
  })

  const searchTool = defineTool({
    name: 'memory_search',
    description:
      '在本机长期记忆库里检索（中文/英文都支持，按相关度 + 重要度 + 新鲜度综合排序）。回答“用户是谁/偏好什么/之前怎么决定/以前做过什么”这类问题前应先检索。query 留空表示按更新时间浏览最近记忆；可用 kind、tags 过滤。结果里的 id 可用于 memory_update / memory_forget。',
    parameters: {
      query: { type: 'string', description: '检索词，中文关键词 2-4 个效果最好；留空 = 浏览最近记忆。' },
      kind: { type: 'string', enum: KINDS, description: '只看某一类记忆（可选）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '要求包含其中任意一个标签（可选）。' },
      limit: { type: 'integer', description: '返回条数 1-50，默认用插件设置 searchDefaultLimit。' },
      minScore: { type: 'number', description: '相关度门槛 0-1（可选，默认 0）。' },
      includeExpired: { type: 'boolean', description: '是否包含已过期记忆（默认 false）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          candidates: { type: 'integer', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                content: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                importance: { type: 'integer', required: true },
                score: { type: 'number', required: true },
                hits: { type: 'integer', required: true },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
                expiresAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render(args, value) {
        if (value.count === 0) return [{ type: 'text', text: value.query.trim() === '' ? '记忆库还是空的。' : `没有找到与“${value.query}”相关的记忆（候选 ${value.candidates} 条）。` }]
        const header = value.query.trim() === '' ? `最近 ${value.count} 条记忆：` : `找到 ${value.count} 条相关记忆：`
        const lines = value.matches.map((row) => line(row))
        return [{ type: 'text', text: `${header}\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      guard()
      if (exec?.signal?.aborted) fail('调用已取消')
      const query = String(args.query ?? '').trim()
      if (query.length > 500) fail('query 太长，请不超过 500 字符')
      const limit = cleanLimit(args.limit, cfg.searchDefaultLimit)
      const minScore = args.minScore === undefined ? 0 : Math.max(0, Math.min(1, Number(args.minScore)))
      const store = getStore()
      const result = store.search({
        query,
        kind: args.kind ?? null,
        tags: cleanTags(args.tags),
        limit,
        minScore,
        includeExpired: args.includeExpired === true,
      })
      return {
        query,
        count: result.rows.length,
        candidates: result.total,
        matches: result.rows.map((row) => ({
          id: row.id,
          content: truncate(row.content, 1200),
          kind: row.kind,
          tags: row.tags,
          importance: row.importance,
          score: Number.isFinite(row.score) ? Math.round(row.score * 1000) / 1000 : 0,
          hits: row.hits,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          expiresAt: row.expiresAt ?? 0,
        })),
      }
    },
  })

  const updateTool = defineTool({
    name: 'memory_update',
    description:
      '修改一条已有记忆（按 id）。用于：信息变了、需要补充细节、调整类型/标签/重要度、或清除过期时间。只更新传入的字段；不要用 memory_save 重复保存同一条记忆。',
    parameters: {
      id: { type: 'integer', required: true, description: '要修改的记忆 id（先用 memory_search 找到）。' },
      content: { type: 'string', description: '新的正文（会重新计算去重指纹）。' },
      kind: { type: 'string', enum: KINDS, description: '新的类型。' },
      tags: { type: 'array', items: { type: 'string' }, description: '新的标签集合（整体替换）。' },
      importance: { type: 'integer', description: '新的重要度 1-5。' },
      clearExpiry: { type: 'boolean', description: '设为 true 表示永不过期。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', required: true },
          fields: { type: 'array', items: { type: 'string' }, required: true },
          total: { type: 'integer', required: true },
        },
      },
      render(args, value) {
        if (value.fields.length === 0) return [{ type: 'text', text: `记忆 #${value.id} 没有变化。` }]
        return [{ type: 'text', text: `已更新记忆 #${value.id} 的 ${value.fields.join('、')}。当前记忆库共 ${value.total} 条。` }]
      },
    },
    async execute(args, exec) {
      guard()
      if (exec?.signal?.aborted) fail('调用已取消')
      if (!Number.isInteger(args.id) || args.id <= 0) fail('id 必须是正整数')
      const patch = { id: args.id }
      if (args.content !== undefined) {
        const content = String(args.content).trim()
        if (content === '') fail('content 不能为空')
        if (content.length > cfg.maxContentChars) fail(`content 太长，上限 ${cfg.maxContentChars}`)
        patch.content = content
      }
      if (args.kind !== undefined) {
        if (!KINDS.includes(args.kind)) fail(`未知 kind：${args.kind}`)
        patch.kind = args.kind
      }
      if (args.tags !== undefined) patch.tags = cleanTags(args.tags)
      if (args.importance !== undefined) patch.importance = cleanImportance(args.importance)
      if (args.clearExpiry === true) patch.clearExpiry = true
      if (Object.keys(patch).length === 1) fail('至少要修改一个字段（content / kind / tags / importance / clearExpiry）')
      const store = getStore()
      const result = store.update(patch)
      if (result === null) fail(`没有 id 为 ${args.id} 的记忆`)
      return { id: result.id, fields: result.fields, total: store.count() }
    },
  })

  const forgetTool = defineTool({
    name: 'memory_forget',
    description:
      '永久删除一条或多条记忆（不可恢复）。只在用户明确要求删除，或确认内容错误/重复/敏感时使用；删除前先用 memory_search 核对 id，不要凭猜测删除。',
    parameters: {
      ids: { type: 'array', items: { type: 'integer' }, required: true, description: '要删除的记忆 id 列表（1-50 个）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'integer', required: true },
          ids: { type: 'array', items: { type: 'integer' }, required: true },
          total: { type: 'integer', required: true },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: `已删除 ${value.removed} 条记忆（#${value.ids.join(', #')}）。当前记忆库共 ${value.total} 条。` }]
      },
    },
    async execute(args, exec) {
      guard()
      if (exec?.signal?.aborted) fail('调用已取消')
      if (!Array.isArray(args.ids) || args.ids.length === 0) fail('ids 至少包含一个 id')
      if (args.ids.length > 50) fail('一次最多删除 50 条')
      if (!args.ids.every((id) => Number.isInteger(id) && id > 0)) fail('ids 里只能放正整数')
      const store = getStore()
      const result = store.forget(args.ids)
      return { removed: result.removed, ids: result.ids, total: store.count() }
    },
  })

  const statsTool = defineTool({
    name: 'memory_stats',
    description: '查看长期记忆库的规模与分布：总条数、各类型数量、热门标签、总字符数、数据库文件路径与大小、最早/最新记录、已过期条数。用于判断是否需要整理或导出。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          contentChars: { type: 'integer', required: true },
          dbPath: { type: 'string', required: true },
          dbBytes: { type: 'integer', required: true },
          expired: { type: 'integer', required: true },
          oldestAt: { type: 'integer', required: true },
          newestAt: { type: 'integer', required: true },
          byKind: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true }, count: { type: 'integer', required: true } } } },
          topTags: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string', required: true }, count: { type: 'integer', required: true } } } },
        },
      },
      render(args, value) {
        const kinds = value.byKind.map((row) => `${KIND_LABELS[row.kind] ?? row.kind} ${row.count}`).join(' / ') || '空'
        const tags = value.topTags.map((row) => `#${row.tag}(${row.count})`).join(' ') || '无'
        return [{
          type: 'text',
          text: `记忆库共 ${value.total} 条（${value.contentChars} 字符，${formatBytes(value.dbBytes)}）\n类型：${kinds}\n热门标签：${tags}\n最早：${day(value.oldestAt)}，最新：${day(value.newestAt)}，已过期：${value.expired}\n数据库：${value.dbPath}`,
        }]
      },
    },
    async execute(_args, exec) {
      guard()
      if (exec?.signal?.aborted) fail('调用已取消')
      const stats = getStore().stats()
      return {
        total: stats.total,
        contentChars: stats.contentChars,
        dbPath: stats.dbPath,
        dbBytes: stats.dbBytes,
        expired: stats.expired,
        oldestAt: stats.oldestAt ?? 0,
        newestAt: stats.newestAt ?? 0,
        byKind: stats.byKind,
        topTags: stats.topTags,
      }
    },
  })

  const exportTool = defineTool({
    name: 'memory_export',
    description: '把全部未过期记忆导出成一个带时间戳的备份文件（Markdown 或 JSON），写入插件设置的导出目录（默认 <DSH_HOME>/memory/exports）。返回文件路径、条数与字节数。适合用户要求“备份/导出记忆”时使用。',
    parameters: {
      format: { type: 'string', enum: ['markdown', 'json'], description: '导出格式，默认 markdown（人可读）；json 便于程序处理或迁移。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          format: { type: 'string', required: true },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: `已导出 ${value.count} 条记忆到 ${value.path}（${formatBytes(value.bytes)}）。` }]
      },
    },
    async execute(args, exec) {
      guard()
      if (exec?.signal?.aborted) fail('调用已取消')
      const format = args.format ?? 'markdown'
      if (!['markdown', 'json'].includes(format)) fail('format 只能是 markdown 或 json')
      const store = getStore()
      return exportFile({ store, dir: cfg.exportDir, format })
    },
  })

  return [saveTool, searchTool, updateTool, forgetTool, statsTool, exportTool]
}

/** 字节数转可读文本。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

