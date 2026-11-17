/**
 * 自动召回与系统提示词说明。
 *
 * 自动召回的实现方式是官方 time-context 插件的同款模式：
 * 在 agent/pre-step 里把一条“来源为 memory 的用户消息”追加进本轮决策消息。
 * 这条消息会由 agent-loop 正常写入会话日志（因此模型看到的每句话都能从日志重建），
 * 不是偷偷改系统提示词，也不会破坏 prompt cache。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KIND_LABELS } from './search.js'
import { recallQueryFrom, truncate } from './text.js'

/** 注入消息的 source.kind（也是会话里识别“这条是自动召回”的标记）。 */
export const MEMORY_SOURCE_KIND = 'memory'

/** 系统提示词里的使用说明。 */
export function guidanceText() {
  return [
    '## 长期记忆（dsh-memory）',
    '你有一个跨会话的本地长期记忆库（SQLite，存储在这台手机上）。它保存用户偏好、历史决定、可复用经验与待办。',
    '- 回答涉及用户是谁、偏好、过去做过什么、此前的约定或长期项目时，先用 memory_search 检索（中文关键词 2-4 个最有效，可用 kind/tags 过滤）。系统每轮也会自动注入少量相关记忆（来源标记为 memory），但自动召回只覆盖最相关的几条。',
    '- 当用户明确说“记住 / 以后都 / 别再”，或出现稳定的偏好、重要决定、可复用经验、未完成待办时，用 memory_save 记录。正文要自包含（对象 + 结论 + 必要的时间）；kind 用 preference/decision/lesson/todo/fact。',
    '- 信息变化时用 memory_update 修正原条目，不要重复保存；用户要求删除或确认内容错误时用 memory_forget（不可恢复，先 search 确认 id）。',
    '- 记忆与当前证据冲突时以当前证据为准，并更新记忆。不要保存密码、验证码、密钥、完整证件号等敏感信息。',
    '- 用户问“你记得什么/看看记忆”时，用 memory_search 空查询浏览最近条目，或 memory_stats 汇报规模。',
  ].join('\n')
}

/** 读取会话事件（优先用缓存快照，避免已弃用的逐条 eventAt）。 */
function readEvents(agent) {
  const session = agent?.session
  if (session === undefined || session === null || typeof session.seq !== 'number') return []
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents(0, session.seq)
    if (typeof session.eventAt === 'function') {
      const events = []
      for (let index = 0; index < session.seq; index += 1) {
        const event = session.eventAt(index)
        if (event !== undefined && event !== null) events.push(event)
      }
      return events
    }
  } catch {
    /* 会话结构变化时返回空数组，自动召回退化为只看 proposed 消息 */
  }
  return []
}

/**
 * 取出本轮用户消息的文本（已进入会话的 + 本轮 proposed 的），排除自动召回消息。
 * @param {object} agent
 * @param {object} decision
 * @returns {string} 清洗后的查询文本
 */
export function turnUserText(agent, decision) {
  const events = readEvents(agent)
  const entered = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start') break
    if (event.type === 'user/message') entered.unshift(event.data)
  }
  const proposed = Array.isArray(decision?.messages) ? decision.messages.filter((message) => message?.role === 'user') : []
  const parts = []
  for (const message of [...entered, ...proposed]) {
    // 只取真正的用户消息。time-context、goal、plan 等插件也会追加 user 角色消息，
    // 那些是系统注入的运行时上下文，不能拿来当记忆检索的查询词。
    const kind = message?.source?.kind
    if (kind !== undefined && kind !== 'user') continue
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return recallQueryFrom(parts.join('\n'), 2000)
}

/**
 * 本轮（或整个会话）是否已经注入过自动召回。
 * @param {object} agent
 * @param {object} [decision]
 * @param {'turn'|'session'} scope
 */
export function alreadyRecalled(agent, decision, scope) {
  const isMemory = (message) => message?.source?.kind === MEMORY_SOURCE_KIND
  if (Array.isArray(decision?.messages) && decision.messages.some(isMemory)) return true
  const events = readEvents(agent)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'user/message' && isMemory(event.data)) return true
    if (scope === 'turn' && event.type === 'turn/start') return false
  }
  return false
}

/**
 * 把检索结果渲染成一条紧凑的注入文本。
 * @param {Array<object>} rows
 * @param {number} maxChars
 */
export function buildRecallText(rows, maxChars) {
  const header = '【长期记忆 · 自动召回】以下是从本机记忆库检索到的相关条目（可能过时；与当前证据冲突时以当前为准）：'
  const footer = '\n（需要更多：memory_search；保存新记忆：memory_save；修正旧记忆：memory_update）'
  const budget = Math.max(0, maxChars - header.length - footer.length)
  const lines = []
  let used = 0
  for (const row of rows) {
    const label = KIND_LABELS[row.kind] ?? row.kind
    const prefix = `- #${row.id} [${label}·重要度${row.importance}] `
    const tags = row.tags.length > 0 ? ` #${row.tags.join(' #')}` : ''
    const room = budget - used - prefix.length - tags.length - 1
    if (room < 40) break
    const body = truncate(String(row.content).replace(/\s+/gu, ' '), Math.min(300, room))
    const text = `${prefix}${body}${tags}`
    lines.push(text)
    used += text.length + 1
  }
  if (lines.length === 0) return ''
  return `${header}\n${lines.join('\n')}${footer}`
}

/**
 * 构造一条可持久化的召回消息。
 * @param {string} text
 */
export function memoryMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: MEMORY_SOURCE_KIND,
      form: 'snapshot',
      sections: [{ name: MEMORY_SOURCE_KIND, text }],
    },
  })
}

/**
 * agent/pre-step 的实际处理：满足条件时返回带召回消息的新决策。
 * @param {{agent:object, decision:object, signal?:AbortSignal, cfg:object, getStore:Function, logger?:object}} input
 */
export function maybeRecall(input) {
  const { agent, decision, signal, cfg, getStore, logger } = input
  if (!cfg.enabled || !cfg.autoRecall) return decision
  if (decision?.kind === 'reject' || signal?.aborted) return decision
  const scope = cfg.recallEveryTurn ? 'turn' : 'session'
  if (alreadyRecalled(agent, decision, scope)) return decision
  const query = turnUserText(agent, decision)
  if (query.trim() === '') return decision
  try {
    const store = getStore()
    const result = store.search({
      query,
      limit: cfg.recallLimit,
      minScore: cfg.recallMinScore,
      touch: true,
    })
    if (result.rows.length === 0) return decision
    const text = buildRecallText(result.rows, cfg.recallMaxChars)
    if (text === '') return decision
    return { ...decision, messages: [...(decision.messages ?? []), memoryMessage(text)] }
  } catch (error) {
    // 召回失败不能阻断对话：记录一条警告后按原决策继续。
    try {
      logger?.warn?.(`dsh-memory: 自动召回失败，已跳过：${error instanceof Error ? error.message : String(error)}`)
    } catch {
      /* 日志不可用时静默 */
    }
    return decision
  }
}
