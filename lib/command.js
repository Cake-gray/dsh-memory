/**
 * 人工斜杠命令 `/memory`：
 *   /memory stats            统计
 *   /memory list [n]         最近 n 条（默认 10）
 *   /memory search <关键词>   检索
 *   /memory forget <id>      删除一条（不可恢复）
 *   /memory export [md|json] 导出备份
 *   /memory help             帮助
 *
 * 命令是面向人的入口，与模型工具是两套注册面；这里只做只读展示与明确的单条删除。
 */

import { exportFile } from './export.js'
import { KIND_LABELS } from './search.js'
import { isoOf, truncate } from './text.js'

const USAGE = [
  '用法：',
  '  /memory stats              查看统计',
  '  /memory list [n]           最近 n 条记忆（默认 10）',
  '  /memory search <关键词>     检索记忆',
  '  /memory forget <id>        删除一条记忆（不可恢复）',
  '  /memory export [md|json]   导出备份到记忆目录',
  '  /memory help               显示本帮助',
].join('\n')

function line(row, max = 160) {
  const label = KIND_LABELS[row.kind] ?? row.kind
  const tags = row.tags.length > 0 ? ` #${row.tags.join(' #')}` : ''
  return `#${row.id} [${label}·${row.importance}] ${truncate(String(row.content).replace(/\s+/gu, ' '), max)}${tags}`
}

function bytes(value) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 注册 /memory 命令。
 * @param {object} ctx Cordis 上下文（需 commands 服务）
 * @param {{getStore:() => import('./store.js').MemoryStore, cfg: ReturnType<import('./config.js').liveConfig>}} deps
 */
export function registerMemoryCommand(ctx, { getStore, cfg }) {
  return ctx.commands.register({
    name: 'memory',
    description: '长期记忆：统计、搜索、删除、导出备份',
    input: { hint: 'stats | list [n] | search <关键词> | forget <id> | export [md|json]' },
    async handler(invocation) {
      if (!cfg.enabled) return { kind: 'error', text: '长期记忆插件已被设置页关闭（enabled=false），请先在插件设置里开启。' }
      const raw = String(invocation?.rawInput ?? '').trim()
      const [sub = 'stats', ...rest] = raw === '' ? ['stats'] : raw.split(/\s+/u)
      const keyword = rest.join(' ').trim()
      try {
        const store = getStore()
        switch (sub.toLowerCase()) {
          case 'help':
          case '?':
            return { kind: 'success', text: USAGE }
          case 'stats': {
            const stats = store.stats()
            const kinds = stats.byKind.map((row) => `${KIND_LABELS[row.kind] ?? row.kind} ${row.count}`).join(' / ') || '空'
            const tags = stats.topTags.map((row) => `#${row.tag}(${row.count})`).join(' ') || '无'
            const text = [
              `长期记忆：${stats.total} 条，${stats.contentChars} 字符，数据库 ${bytes(stats.dbBytes)}`,
              `类型：${kinds}`,
              `热门标签：${tags}`,
              `最早 ${isoOf(stats.oldestAt) || '—'} / 最新 ${isoOf(stats.newestAt) || '—'} / 已过期 ${stats.expired}`,
              `文件：${stats.dbPath}`,
              '',
              '更多：/memory search <关键词>、/memory list 20、/memory export',
            ].join('\n')
            return { kind: 'success', text }
          }
          case 'list': {
            const n = rest[0] === undefined ? 10 : Math.max(1, Math.min(50, Number.parseInt(rest[0], 10) || 10))
            const result = store.search({ query: '', limit: n })
            if (result.rows.length === 0) return { kind: 'success', text: '记忆库还是空的。让模型用 memory_save 保存，或直接对它说“记住：……”。' }
            return { kind: 'success', text: `最近 ${result.rows.length} 条：\n${result.rows.map((row) => line(row)).join('\n')}` }
          }
          case 'search': {
            if (keyword === '') return { kind: 'error', text: '请提供关键词：/memory search 火锅' }
            const result = store.search({ query: keyword, limit: 10 })
            if (result.rows.length === 0) return { kind: 'success', text: `没有找到与“${keyword}”相关的记忆（候选 ${result.total} 条）。` }
            return { kind: 'success', text: `找到 ${result.rows.length} 条：\n${result.rows.map((row) => line(row)).join('\n')}` }
          }
          case 'forget': {
            const id = Number.parseInt(rest[0] ?? '', 10)
            if (!Number.isInteger(id) || id <= 0) return { kind: 'error', text: '请提供要删除的 id：/memory forget 12（可先用 /memory search 查找）' }
            const result = store.forget([id])
            if (result.removed === 0) return { kind: 'error', text: `没有 id 为 ${id} 的记忆。` }
            return { kind: 'success', text: `已删除记忆 #${id}。当前共 ${store.count()} 条。` }
          }
          case 'export': {
            const format = (rest[0] ?? 'md').toLowerCase()
            if (!['md', 'markdown', 'json'].includes(format)) return { kind: 'error', text: '格式只能是 md 或 json。' }
            const result = exportFile({ store, dir: cfg.exportDir, format: format === 'json' ? 'json' : 'markdown' })
            return { kind: 'success', text: `已导出 ${result.count} 条记忆（${bytes(result.bytes)}）到：\n${result.path}` }
          }
          default:
            return { kind: 'error', text: `未知子命令：${sub}\n\n${USAGE}` }
        }
      } catch (error) {
        return { kind: 'error', text: `/memory 执行失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}
