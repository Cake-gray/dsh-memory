import test from 'node:test'
import assert from 'node:assert/strict'
import { queryTerms, normalizeText, truncate, recallQueryFrom } from '../lib/text.js'
import { scoreRows, recentRows, KINDS } from '../lib/search.js'

function row(id, content, extra = {}) {
  return {
    id,
    content,
    contentNorm: normalizeText(content),
    tagNorm: normalizeText((extra.tags ?? []).join(' ')),
    tags: extra.tags ?? [],
    kind: extra.kind ?? 'fact',
    importance: extra.importance ?? 3,
    updatedAt: extra.updatedAt ?? Date.now(),
    hits: extra.hits ?? 0,
    createdAt: extra.updatedAt ?? Date.now(),
    expiresAt: null,
    source: 'test',
  }
}

test('中文二分词：2 字实词可以命中', () => {
  const terms = queryTerms('火锅')
  assert.deepEqual(terms, ['火锅'])
  const rows = [row(1, '用户喜欢周五晚上吃火锅'), row(2, '用户住在杭州')]
  const result = scoreRows(rows, '火锅', { minScore: 0 })
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 1)
  assert.ok(result[0].score > 0)
})

test('中文查询：相关度排序正确', () => {
  const rows = [
    row(1, '用户喜欢在周末去公园散步'),
    row(2, '用户喜欢吃火锅，尤其是周五晚上'),
    row(3, '项目使用 TypeScript 开发'),
  ]
  const result = scoreRows(rows, '周五火锅', { minScore: 0 })
  assert.equal(result[0].id, 2)
  assert.ok(result[0].score > (result[1]?.score ?? 0))
})

test('自然语言长句：只按库里出现过的词计算覆盖率', () => {
  const rows = [
    row(1, '用户喜欢周五晚上吃火锅，偏好微辣'),
    row(2, '用户住在杭州，喜欢安静的地方'),
  ]
  const result = scoreRows(rows, '帮我找一下周五晚上吃火锅的地方', { minScore: 0.16 })
  assert.ok(result.length >= 1)
  assert.equal(result[0].id, 1)
  assert.ok(result[0].score > 0.3)
  assert.ok(result[0].score > result[1].score)
})

test('英文按单词匹配，且有整句短语加成', () => {
  const rows = [row(1, 'The user prefers dark mode'), row(2, 'The user likes light theme')]
  const one = scoreRows(rows, 'dark mode', { minScore: 0 })
  assert.equal(one[0].id, 1)
  const phrase = scoreRows(rows, 'prefers dark mode', { minScore: 0 })
  assert.equal(phrase[0].id, 1)
})

test('标签参与打分，重要度与命中次数提高分数', () => {
  const now = Date.now()
  const low = row(1, '喜欢安静的地方', { tags: ['旅行'], importance: 1, updatedAt: now - 400 * 86400000 })
  const high = row(2, '喜欢安静的地方', { tags: ['旅行'], importance: 5, updatedAt: now, hits: 9 })
  const result = scoreRows([low, high], '旅行', { minScore: 0, now })
  assert.equal(result[0].id, 2)
  assert.ok(result[0].score > result[1].score)
})

test('minScore 过滤弱相关', () => {
  const rows = [row(1, '完全无关的内容')]
  assert.equal(scoreRows(rows, '火锅', { minScore: 0.2 }).length, 0)
})

test('空查询返回空数组；recentRows 按更新时间倒序', () => {
  const now = Date.now()
  const rows = [row(1, 'a', { updatedAt: now - 1000 }), row(2, 'b', { updatedAt: now })]
  assert.deepEqual(scoreRows(rows, '   '), [])
  assert.deepEqual(recentRows(rows, 1).map((r) => r.id), [2])
})

test('单字查询退化为子串命中', () => {
  const rows = [row(1, '猫喜欢晒太阳'), row(2, '狗喜欢跑步')]
  const result = scoreRows(rows, '猫', { minScore: 0 })
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 1)
})

test('text helpers', () => {
  assert.equal(normalizeText('  ＡＢＣ　火锅  '), 'abc 火锅')
  assert.equal(truncate('一二三四五', 3), '一二…')
  assert.equal(recallQueryFrom('看这里 https://example.com/a，然后 ```js\nx\n``` 再说'), '看这里 ，然后 再说')
  assert.ok(KINDS.includes('preference'))
})
