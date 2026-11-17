import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore, fingerprint, parseTags } from '../lib/store.js'

const root = mkdtempSync(join(process.env.HOME ?? '.', '.dsh-memory-test-'))
let counter = 0
function freshStore() {
  counter += 1
  return new MemoryStore(join(root, `db-${counter}`, 'memory.sqlite')).open()
}

test.after(() => rmSync(root, { recursive: true, force: true }))

test('保存、按 id 读取、计数', () => {
  const store = freshStore()
  const saved = store.save({ content: '用户喜欢周五晚上吃火锅', kind: 'preference', tags: ['饮食'], importance: 4, now: 1000 })
  assert.equal(saved.duplicate, false)
  assert.equal(saved.id, 1)
  const row = store.get(1)
  assert.equal(row.content, '用户喜欢周五晚上吃火锅')
  assert.deepEqual(row.tags, ['饮食'])
  assert.equal(row.importance, 4)
  assert.equal(store.count(), 1)
  store.close()
})

test('去重：相同正文只保留一条，并合并标签与重要度', () => {
  const store = freshStore()
  const a = store.save({ content: '用户喜欢火锅', kind: 'preference', tags: ['饮食'], importance: 3 })
  const b = store.save({ content: ' 用户喜欢火锅 ', kind: 'preference', tags: ['周末'], importance: 5 })
  assert.equal(a.duplicate, false)
  assert.equal(b.duplicate, true)
  assert.equal(b.id, a.id)
  assert.deepEqual(store.get(a.id).tags.sort(), ['周末', '饮食'].sort())
  assert.equal(store.get(a.id).importance, 5)
  assert.equal(store.count(), 1)
  store.close()
})

test('检索：中文命中 + 命中计数增加；按类型/标签过滤', () => {
  const store = freshStore()
  store.save({ content: '用户喜欢周五晚上吃火锅', kind: 'preference', tags: ['饮食', '周末'], importance: 4 })
  store.save({ content: '项目使用 TypeScript', kind: 'fact', tags: ['开发'], importance: 2 })
  const result = store.search({ query: '火锅' })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].id, 1)
  assert.equal(store.get(1).hits, 1)
  assert.equal(store.search({ query: '火锅', kind: 'fact' }).rows.length, 0)
  assert.equal(store.search({ query: '', tags: ['开发'] }).rows.length, 1)
  assert.equal(store.search({ query: '', limit: 1 }).rows.length, 1)
  store.close()
})

test('过期记忆默认不返回，includeExpired 可以看到', () => {
  const now = Date.now()
  const store = freshStore()
  store.save({ content: '临时约定：下周三交稿', kind: 'todo', expiresAt: now - 1000, now: now - 2000 })
  store.save({ content: '长期偏好：喜欢安静', kind: 'preference', expiresAt: now + 100000, now })
  assert.equal(store.count({ now }), 1)
  assert.equal(store.search({ query: '', now }).rows.length, 1)
  assert.equal(store.search({ query: '', now, includeExpired: true }).rows.length, 2)
  assert.equal(store.stats(now).expired, 1)
  store.close()
})

test('更新：修改正文会重算指纹，未知 id 返回 null', () => {
  const store = freshStore()
  store.save({ content: '旧内容', kind: 'fact', tags: ['a'] })
  const updated = store.update({ id: 1, content: '新内容', importance: 5, tags: ['b', 'c'] })
  assert.deepEqual(updated.fields.sort(), ['content', 'importance', 'tags'].sort())
  assert.equal(store.get(1).content, '新内容')
  assert.equal(store.get(1).importance, 5)
  assert.deepEqual(store.get(1).tags, ['b', 'c'])
  assert.equal(store.update({ id: 999, importance: 2 }), null)
  store.close()
})

test('删除：返回实际删除数量', () => {
  const store = freshStore()
  store.save({ content: 'a' })
  store.save({ content: 'b' })
  store.save({ content: 'c' })
  assert.equal(store.forget([1, 3, 999]).removed, 2)
  assert.equal(store.count(), 1)
  assert.equal(store.get(2).content, 'b')
  assert.equal(store.forget([]).removed, 0)
  store.close()
})

test('容量裁剪：优先删除低重要度、从未命中的旧条目', () => {
  const store = freshStore()
  const base = Date.now() - 100000
  store.save({ content: '重要且常用', importance: 5, now: base })
  store.save({ content: '低重要度旧条目', importance: 1, now: base })
  store.save({ content: '低重要度新条目', importance: 1, now: base + 5000 })
  store.search({ query: '重要' }) // 让第 1 条有命中记录
  assert.equal(store.prune(2), 1)
  const remaining = store.search({ query: '', includeExpired: true }).rows.map((row) => row.content)
  assert.deepEqual(remaining.sort(), ['低重要度新条目', '重要且常用'].sort())
  store.close()
})

test('统计与导出', () => {
  const store = freshStore()
  store.save({ content: '偏好一', kind: 'preference', tags: ['饮食'], importance: 4 })
  store.save({ content: '事实一', kind: 'fact', tags: ['开发'] })
  const stats = store.stats()
  assert.equal(stats.total, 2)
  assert.equal(stats.contentChars, 6)
  assert.ok(stats.dbBytes > 0)
  assert.ok(stats.byKind.some((row) => row.kind === 'preference' && row.count === 1))
  assert.ok(stats.topTags.some((row) => row.tag === '饮食'))
  const rows = store.exportRows()
  assert.equal(rows.length, 2)
  assert.ok(Array.isArray(rows[0].tags))
  store.close()
})

test('重开数据库后数据仍在（持久化）', () => {
  const file = join(root, 'persist', 'memory.sqlite')
  const store = new MemoryStore(file).open()
  store.save({ content: '持久化测试' })
  store.close()
  assert.ok(existsSync(file))
  const again = new MemoryStore(file).open()
  assert.equal(again.search({ query: '持久化' }).rows.length, 1)
  again.close()
})

test('fingerprint 对空白差异稳定；parseTags 容错', () => {
  assert.equal(fingerprint(' 你好  世界 '), fingerprint('你好 世界'))
  assert.deepEqual(parseTags('not-json'), [])
  assert.deepEqual(parseTags('["a","b"]'), ['a', 'b'])
})
