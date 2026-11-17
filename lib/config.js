/**
 * 插件配置（Schemastery Schema）。
 *
 * 所有字段都标了 .volatile()：在 DSH 的插件设置页里保存后会热更新到正在运行的实例，
 * 不需要重启、也不会重建插件（背景任务、记忆库连接都保持原样）。
 * apply() 里拿到的不是值而是引用，必须通过 liveConfig() 的 getter 读取“此刻的值”。
 *
 * 每个字段都有默认值，因此 cordis.patch.yml 里可以不写任何 config。
 */

import z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 记忆库默认文件名。 */
export const DEFAULT_DB_NAME = 'memory.sqlite'

/**
 * 解析 DSH 主目录：优先 $DSH_HOME，其次从 profileContext.dir 反推，
 * 最后退回 ~/.dsh（与 DSH 自身的 resolveDshHome 规则一致）。
 * @param {object} [ctx] Cordis 上下文
 * @returns {string} 绝对路径
 */
export function resolveDshHome(ctx) {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return resolve(env)
  const profileDir = ctx?.get?.('profileContext')?.dir
  if (typeof profileDir === 'string' && profileDir.trim() !== '') return dirname(dirname(resolve(profileDir)))
  return join(homedir(), '.dsh')
}

/** 展开 `~` 与相对路径。 */
export function expandPath(input, home) {
  const raw = String(input ?? '').trim()
  if (raw === '') return ''
  let path = raw
  if (path === '~') path = homedir()
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
  if (!isAbsolute(path)) path = join(home, path)
  return resolve(path)
}

export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('总开关。关闭后不再注册任何记忆工具、不自动召回，也不往系统提示词里加说明；已写入的记忆仍保留在数据库里。'),
  storePath: z.string().default('').volatile().description('记忆库文件路径。留空 = <DSH_HOME>/memory/memory.sqlite；可填绝对路径或 ~/ 开头的路径。修改后自动切换到新库（旧库不删除）。'),
  autoRecall: z.boolean().default(true).volatile().description('自动召回：每次你发消息时，按内容检索少量相关记忆，作为一条来源为 memory 的用户消息注入本轮请求。'),
  recallEveryTurn: z.boolean().default(true).volatile().description('自动召回范围。开启 = 每一轮都召回；关闭 = 每个会话只在第一轮召回一次（更省 token）。'),
  recallLimit: z.natural().min(1).max(10).default(4).volatile().description('每轮最多自动召回几条记忆（1-10）。'),
  recallMinScore: z.number().min(0).max(1).default(0.16).volatile().description('自动召回的相关度门槛（0-1）。越高越严格，越低越容易把弱相关记忆也带进来。'),
  recallMaxChars: z.natural().min(200).max(8000).default(1200).volatile().description('一次自动召回注入文本的字符上限，防止挤占上下文。'),
  guidance: z.boolean().default(true).volatile().description('在系统提示词中加入“长期记忆”使用说明，提醒模型主动检索、保存与修正记忆。'),
  defaultKind: z.union(['fact', 'preference', 'decision', 'lesson', 'todo', 'event']).default('fact').volatile().description('调用 memory_save 未指定类型时使用的默认类型。'),
  maxMemories: z.natural().min(100).max(100000).default(5000).volatile().description('记忆库条数上限。超出后自动淘汰“重要度低、从未命中、最久未更新”的旧条目（默认 5000）。'),
  dedupe: z.boolean().default(true).volatile().description('保存时按归一化正文去重：相同内容只保留一条，并把新标签与更高重要度合并进去。'),
  maxContentChars: z.natural().min(200).max(20000).default(4000).volatile().description('单条记忆正文的最大字符数（memory_save 与 memory_update 都受它约束）。'),
  searchDefaultLimit: z.natural().min(1).max(50).default(8).volatile().description('memory_search 未指定 limit 时返回的条数。'),
  exportDir: z.string().default('').volatile().description('导出目录。留空 = <DSH_HOME>/memory/exports；memory_export 工具与 /memory export 都写到这里。'),
})

/**
 * 读取“此刻的值”：volatile 字段是 { get() } 引用，普通字段是值本身。
 * @param {unknown} field
 */
function val(field) {
  return field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field
}

/**
 * 生成一个按需读取最新配置的视图。
 * @param {object} config apply() 收到的原始 Config
 * @param {{dshHome?:string}} [options]
 */
export function liveConfig(config, options = {}) {
  const home = options.dshHome ?? resolveDshHome()
  const storePath = () => {
    const expanded = expandPath(val(config.storePath), home)
    return expanded !== '' ? expanded : join(home, 'memory', DEFAULT_DB_NAME)
  }
  const exportDir = () => {
    const expanded = expandPath(val(config.exportDir), home)
    return expanded !== '' ? expanded : join(home, 'memory', 'exports')
  }
  return {
    home,
    get enabled() { return val(config.enabled) !== false },
    get storePath() { return storePath() },
    get autoRecall() { return val(config.autoRecall) !== false },
    get recallEveryTurn() { return val(config.recallEveryTurn) !== false },
    get recallLimit() { return clampInt(val(config.recallLimit), 1, 10, 4) },
    get recallMinScore() { return clampNumber(val(config.recallMinScore), 0, 1, 0.16) },
    get recallMaxChars() { return clampInt(val(config.recallMaxChars), 200, 8000, 1200) },
    get guidance() { return val(config.guidance) !== false },
    get defaultKind() { const kind = val(config.defaultKind); return ['fact', 'preference', 'decision', 'lesson', 'todo', 'event'].includes(kind) ? kind : 'fact' },
    get maxMemories() { return clampInt(val(config.maxMemories), 100, 100000, 5000) },
    get dedupe() { return val(config.dedupe) !== false },
    get maxContentChars() { return clampInt(val(config.maxContentChars), 200, 20000, 4000) },
    get searchDefaultLimit() { return clampInt(val(config.searchDefaultLimit), 1, 50, 8) },
    get exportDir() { return exportDir() },
    get dbExists() { return existsSync(storePath()) },
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
