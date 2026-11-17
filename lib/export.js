/**
 * 记忆导出：把数据库里的条目渲染成 Markdown 或 JSON，并写入带时间戳的文件。
 * 工具（memory_export）与人工命令（/memory export）共用这里的实现。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isoOf } from './text.js'
import { KIND_LABELS } from './search.js'

/** 去掉仅用于检索的内部字段，得到稳定的对外结构。 */
export function stripInternals(row) {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    tags: row.tags,
    importance: row.importance,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hits: row.hits,
    lastHitAt: row.lastHitAt ?? 0,
    expiresAt: row.expiresAt ?? 0,
  }
}

const KIND_ORDER = ['preference', 'decision', 'lesson', 'todo', 'fact', 'event']

function kindRank(kind) {
  const index = KIND_ORDER.indexOf(kind)
  return index < 0 ? KIND_ORDER.length : index
}

/**
 * 人类可读的 Markdown 导出。
 * @param {Array<object>} rows 来自 store.exportRows()
 * @param {number} now
 */
export function renderMarkdown(rows, now = Date.now()) {
  const lines = [
    '# 长期记忆导出',
    '',
    `- 导出时间：${isoOf(now)}`,
    `- 条数：${rows.length}`,
    '',
    '---',
    '',
  ]
  const byKind = new Map()
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, [])
    byKind.get(row.kind).push(row)
  }
  const kinds = [...byKind.keys()].sort((a, b) => kindRank(a) - kindRank(b))
  for (const kind of kinds) {
    lines.push(`## ${KIND_LABELS[kind] ?? kind}（${byKind.get(kind).length}）`, '')
    for (const row of byKind.get(kind)) {
      const tags = row.tags.length > 0 ? ` · #${row.tags.join(' #')}` : ''
      lines.push(`- **#${row.id}** 重要度 ${row.importance}${tags}`)
      for (const textLine of String(row.content).split('\n')) lines.push(`  ${textLine}`)
      lines.push(`  <sub>创建 ${isoOf(row.createdAt) || '未知'} / 更新 ${isoOf(row.updatedAt) || '未知'} / 命中 ${row.hits} 次</sub>`, '')
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * 供程序处理/迁移的 JSON 导出。
 * @param {Array<object>} rows
 * @param {number} now
 */
export function renderJson(rows, now = Date.now()) {
  return JSON.stringify(
    { exportedAt: isoOf(now), schema: 1, plugin: 'dsh-memory', count: rows.length, memories: rows.map(stripInternals) },
    null,
    2,
  )
}

/**
 * 导出到文件。
 * @param {{store: import('./store.js').MemoryStore, dir: string, format?: 'markdown'|'json', now?: number, prefix?: string}} input
 * @returns {{path:string,count:number,bytes:number,format:string}}
 */
export function exportFile(input) {
  const now = input.now ?? Date.now()
  const format = input.format === 'json' ? 'json' : 'markdown'
  const rows = input.store.exportRows(now)
  const dir = input.dir
  mkdirSync(dir, { recursive: true })
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, '-')
  const extension = format === 'json' ? 'json' : 'md'
  const path = join(dir, `${input.prefix ?? 'memory'}-${stamp}.${extension}`)
  const text = format === 'json' ? renderJson(rows, now) : renderMarkdown(rows, now)
  writeFileSync(path, text, 'utf8')
  return { path, count: rows.length, bytes: Buffer.byteLength(text, 'utf8'), format }
}
