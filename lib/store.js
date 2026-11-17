/**
 * SQLite 记忆存储（node:sqlite，本机文件）。
 *
 * 为什么用 node:sqlite 而不是 better-sqlite3：
 * - Node 24 内置，无需原生模块编译；Android 上装不了 node-gyp；
 * - 单文件、可备份、可导出；WAL 模式允许多个 DSH 进程（主进程 / 子进程）同时读写。
 *
 * 表结构只有一张 memories 表 + 一张 meta 表，刻意保持简单，方便用户用
 * MT 管理器 / sqlite3 / 任意工具直接查看。
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeText } from './text.js'
import { KINDS, recentRows, scoreRows } from './search.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT    NOT NULL,
  norm_hash   TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'fact',
  tags        TEXT    NOT NULL DEFAULT '[]',
  importance  INTEGER NOT NULL DEFAULT 3,
  source      TEXT    NOT NULL DEFAULT 'tool',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  expires_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_hash    ON memories(norm_hash);
CREATE INDEX IF NOT EXISTS idx_memories_kind    ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`

/** 内容归一化指纹：用于去重（前 32 个 hex 字符足够）。 */
export function fingerprint(content) {
  return createHash('sha256').update(normalizeText(content)).digest('hex').slice(0, 32)
}

/** 安全地解析 tags JSON。 */
export function parseTags(text) {
  try {
    const value = JSON.parse(text ?? '[]')
    return Array.isArray(value) ? value.filter((tag) => typeof tag === 'string') : []
  } catch {
    return []
  }
}

/**
 * 把数据库行转换成带 camelCase / 预处理字段的对象。
 * @param {object} row
 */
function toRow(row) {
  const tags = parseTags(row.tags)
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    tags,
    importance: row.importance,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hits: row.hits,
    lastHitAt: row.last_hit_at,
    expiresAt: row.expires_at,
    contentNorm: normalizeText(row.content),
    tagNorm: normalizeText(tags.join(' ')),
  }
}

export class MemoryStore {
  /**
   * @param {string} file 数据库文件绝对路径
   */
  constructor(file) {
    this.file = file
    this.db = null
  }

  open() {
    if (this.db !== null) return this
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const db = new DatabaseSync(this.file)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 3000')
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(SCHEMA)
      db.exec('PRAGMA user_version = 1')
      this.db = db
    } catch (error) {
      throw new Error(`无法打开记忆数据库 ${this.file}：${error instanceof Error ? error.message : String(error)}`)
    }
    return this
  }

  close() {
    const db = this.db
    this.db = null
    if (db === null) return
    try {
      db.close()
    } catch {
      /* 关闭失败不应该阻断卸载流程 */
    }
  }

  /** 确保已打开，返回底层 DatabaseSync（仅本模块使用）。 */
  #db() {
    this.open()
    return this.db
  }

  /**
   * 统计未过期（或全部）记忆条数。
   * @param {{includeExpired?:boolean, now?:number}} [options]
   */
  count(options = {}) {
    const now = options.now ?? Date.now()
    const db = this.#db()
    if (options.includeExpired === true) {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n)
    }
    return Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE expires_at IS NULL OR expires_at > ?').get(now).n)
  }

  /**
   * 保存一条记忆。
   * @param {{content:string, kind:string, tags:string[], importance:number, source?:string, expiresAt?:number|null, dedupe?:boolean, now?:number}} input
   * @returns {{id:number, duplicate:boolean, kind:string, importance:number, tags:string[]}}
   */
  save(input) {
    const now = input.now ?? Date.now()
    const dedupe = input.dedupe !== false
    const content = String(input.content)
    const kind = KINDS.includes(input.kind) ? input.kind : 'fact'
    const tags = [...new Set((input.tags ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    const importance = Math.max(1, Math.min(5, Math.round(input.importance ?? 3)))
    const expiresAt = Number.isFinite(input.expiresAt) && input.expiresAt > now ? Math.round(input.expiresAt) : null
    const db = this.#db()
    const normHash = fingerprint(content)

    if (dedupe) {
      const existing = db.prepare('SELECT * FROM memories WHERE norm_hash = ? ORDER BY id LIMIT 1').get(normHash)
      if (existing !== undefined) {
        const mergedTags = [...new Set([...parseTags(existing.tags), ...tags])].slice(0, 12)
        const mergedImportance = Math.max(existing.importance, importance)
        db.prepare('UPDATE memories SET tags = ?, importance = ?, updated_at = ?, expires_at = ? WHERE id = ?').run(
          JSON.stringify(mergedTags),
          mergedImportance,
          now,
          expiresAt ?? existing.expires_at,
          existing.id,
        )
        return { id: existing.id, duplicate: true, kind: existing.kind, importance: mergedImportance, tags: mergedTags }
      }
    }

    const result = db
      .prepare(
        'INSERT INTO memories (content, norm_hash, kind, tags, importance, source, created_at, updated_at, hits, last_hit_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)',
      )
      .run(content, normHash, kind, JSON.stringify(tags), importance, String(input.source ?? 'tool'), now, now, expiresAt)
    return { id: Number(result.lastInsertRowid), duplicate: false, kind, importance, tags }
  }

  /** 按 id 读取一条（含已过期）。 */
  get(id) {
    const row = this.#db().prepare('SELECT * FROM memories WHERE id = ?').get(Number(id))
    return row === undefined ? null : toRow(row)
  }

  /**
   * 修改一条记忆；只更新传入的字段。
   * @param {{id:number, content?:string, kind?:string, tags?:string[], importance?:number, clearExpiry?:boolean, expiresAt?:number|null}} patch
   * @returns {{id:number, fields:string[]}|null} null 表示 id 不存在
   */
  update(patch) {
    const db = this.#db()
    const id = Number(patch.id)
    const existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    if (existing === undefined) return null
    const sets = []
    const values = []
    const fields = []
    if (patch.content !== undefined) {
      const content = String(patch.content)
      sets.push('content = ?', 'norm_hash = ?')
      values.push(content, fingerprint(content))
      fields.push('content')
    }
    if (patch.kind !== undefined && KINDS.includes(patch.kind)) {
      sets.push('kind = ?')
      values.push(patch.kind)
      fields.push('kind')
    }
    if (patch.tags !== undefined) {
      const tags = [...new Set(patch.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12)
      sets.push('tags = ?')
      values.push(JSON.stringify(tags))
      fields.push('tags')
    }
    if (patch.importance !== undefined) {
      const importance = Math.max(1, Math.min(5, Math.round(patch.importance)))
      sets.push('importance = ?')
      values.push(importance)
      fields.push('importance')
    }
    if (patch.clearExpiry === true) {
      sets.push('expires_at = NULL')
      fields.push('expiresAt')
    } else if (patch.expiresAt !== undefined) {
      sets.push('expires_at = ?')
      values.push(Number.isFinite(patch.expiresAt) ? Math.round(patch.expiresAt) : null)
      fields.push('expiresAt')
    }
    if (sets.length === 0) return { id, fields: [] }
    sets.push('updated_at = ?')
    values.push(Date.now())
    db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    return { id, fields }
  }

  /**
   * 永久删除若干条记忆。
   * @param {number[]} ids
   * @returns {{removed:number, ids:number[]}}
   */
  forget(ids) {
    const clean = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    if (clean.length === 0) return { removed: 0, ids: [] }
    const placeholders = clean.map(() => '?').join(', ')
    const result = this.#db().prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...clean)
    return { removed: Number(result.changes), ids: clean }
  }

  /**
   * 检索（空 query = 按更新时间倒序浏览）。
   * @param {{query?:string, kind?:string|null, tags?:string[], limit?:number, minScore?:number, includeExpired?:boolean, now?:number, touch?:boolean}} [options]
   */
  search(options = {}) {
    const now = options.now ?? Date.now()
    const limit = Math.max(1, Math.min(100, Math.round(options.limit ?? 8)))
    const query = String(options.query ?? '')
    const kind = options.kind ?? null
    const tags = (options.tags ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
    const includeExpired = options.includeExpired === true
    const touch = options.touch !== false
    const db = this.#db()

    const raw = db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all()
    const rows = []
    for (const row of raw) {
      if (!includeExpired && row.expires_at !== null && row.expires_at <= now) continue
      if (kind !== null && row.kind !== kind) continue
      const prepared = toRow(row)
      if (tags.length > 0 && !tags.some((tag) => prepared.tags.includes(tag))) continue
      rows.push(prepared)
    }

    let top
    if (normalizeText(query) === '') {
      top = recentRows(rows, limit)
    } else {
      const minScore = Number.isFinite(options.minScore) ? options.minScore : 0
      top = scoreRows(rows, query, { now, minScore }).slice(0, limit)
      if (touch && top.length > 0) {
        const ids = top.map((row) => row.id)
        const placeholders = ids.map(() => '?').join(', ')
        db.prepare(`UPDATE memories SET hits = hits + 1, last_hit_at = ? WHERE id IN (${placeholders})`).run(now, ...ids)
      }
    }
    return { rows: top, total: rows.length }
  }

  /** 导出全部（未过期）记忆，按类型分组、更新时间倒序。 */
  exportRows(now = Date.now()) {
    const raw = this.#db()
      .prepare('SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > ? ORDER BY kind ASC, updated_at DESC')
      .all(now)
    return raw.map(toRow)
  }

  /**
   * 超出上限时裁剪：先删重要度低、从未使用、最久未更新的。
   * @param {number} max
   * @returns {number} 删除条数
   */
  prune(max) {
    const cap = Math.max(1, Math.round(max))
    const db = this.#db()
    const total = this.count({ includeExpired: true })
    if (total <= cap) return 0
    const overflow = total - cap
    const result = db
      .prepare(
        `DELETE FROM memories WHERE id IN (
           SELECT id FROM memories
           ORDER BY importance ASC, COALESCE(last_hit_at, 0) ASC, updated_at ASC
           LIMIT ?
         )`,
      )
      .run(overflow)
    return Number(result.changes)
  }

  /** 汇总统计。 */
  stats(now = Date.now()) {
    const db = this.#db()
    const total = this.count({ now })
    const all = db.prepare('SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > ?').all(now)
    const byKind = new Map()
    const tagCounts = new Map()
    let contentChars = 0
    let oldest = null
    let newest = null
    for (const row of all) {
      byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1)
      contentChars += String(row.content).length
      if (oldest === null || row.created_at < oldest) oldest = row.created_at
      if (newest === null || row.created_at > newest) newest = row.created_at
      for (const tag of parseTags(row.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
    let dbBytes = 0
    try {
      dbBytes = statSync(this.file).size
    } catch {
      dbBytes = 0
    }
    return {
      total,
      byKind: [...byKind].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
      topTags: [...tagCounts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 12),
      contentChars,
      dbPath: this.file,
      dbBytes,
      oldestAt: oldest,
      newestAt: newest,
      expired: Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?').get(now).n),
    }
  }
}
