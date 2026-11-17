/**
 * 记忆检索打分（纯函数，无 I/O）。
 *
 * 存储层把每条记忆预处理成：
 *   { id, contentNorm, tagNorm, importance, updatedAt, hits, ... }
 * 本模块只负责把「查询」和「候选行」变成带 score 的排序结果。
 *
 * 为什么不用 FTS5：
 * - 内置 trigram 分词器对 2 个汉字的词（“火锅”“周五”）完全无法命中，而中文里 2 字词占大多数；
 * - 记忆条数上限默认 5000，线性扫描 + IDF 加权的耗时在毫秒级，简单、可测试、无隐藏行为。
 */

import { normalizeText, queryTerms } from './text.js'

/** 允许的记忆类型。 */
export const KINDS = ['fact', 'preference', 'decision', 'lesson', 'todo', 'event']

/** 类型的中文标签（仅用于渲染，不参与存储）。 */
export const KIND_LABELS = {
  fact: '事实',
  preference: '偏好',
  decision: '决定',
  lesson: '经验',
  todo: '待办',
  event: '事件',
}

/** 打分权重：合计 1.0，方便把分数解释为 0~1 的相关度。 */
export const WEIGHTS = {
  coverage: 0.55,
  tag: 0.15,
  phrase: 0.1,
  freshness: 0.06,
  importance: 0.09,
  usage: 0.05,
}

/**
 * 给候选记忆打分并排序。
 *
 * 分数 = 内容命中覆盖率(按 IDF 加权) * 0.55
 *      + 标签命中覆盖率              * 0.15
 *      + 整句短语命中                * 0.10
 *      + 新鲜度（45 天半衰期）        * 0.06
 *      + 重要度（1~5 映射到 0~1）     * 0.09
 *      + 使用次数（命中过几次）        * 0.05
 *
 * @param {Array<object>} rows 预处理过的候选行
 * @param {string} query 查询文本
 * @param {{now?:number,minScore?:number}} [options]
 * @returns {Array<object>} 过滤并按分数降序排列的副本（附 score、matchedTerms）
 */
export function scoreRows(rows, query, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0
  const normQuery = normalizeText(query)
  if (normQuery === '' || !Array.isArray(rows) || rows.length === 0) return []

  const terms = queryTerms(query)
  const total = rows.length

  // 文档频率：一个词出现在多少条记忆里。出现越普遍，权重越低（IDF）。
  const df = new Map()
  for (const term of terms) df.set(term, 0)
  for (const row of rows) {
    const content = row.contentNorm ?? ''
    const tags = row.tagNorm ?? ''
    for (const term of terms) {
      if (content.includes(term) || tags.includes(term)) df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  // 只保留“语料里真正出现过”的词参与覆盖率分母。
  // 否则一句自然语言（“帮我找一下周五晚上吃火锅的地方”）会带进十几个库里根本没有的词，
  // 把一个真正命中的“火锅”稀释成接近 0 分，自动召回就会漏掉。
  const weighted = terms
    .map((term) => ({ term, docFreq: df.get(term) ?? 0 }))
    .filter((entry) => entry.docFreq > 0)
    .map((entry) => ({ term: entry.term, weight: Math.log(1 + total / (1 + entry.docFreq)) }))
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0)
  if (totalWeight <= 0) return []

  const results = []
  for (const row of rows) {
    const content = row.contentNorm ?? ''
    const tags = row.tagNorm ?? ''
    let contentWeight = 0
    let tagWeight = 0
    let matched = 0
    for (const entry of weighted) {
      const inContent = content.includes(entry.term)
      const inTags = tags.includes(entry.term)
      if (!inContent && !inTags) continue
      matched += 1
      if (inContent) contentWeight += entry.weight
      if (inTags) tagWeight += entry.weight
    }
    const phrase = normQuery.length >= 2 && content.includes(normQuery)
    // 单字/整句兜底：没有命中任何词，但正文包含完整查询时，视为弱命中。
    if (matched === 0 && !phrase) continue

    const coverage = contentWeight / totalWeight
    const tagCoverage = tagWeight / totalWeight
    const ageDays = Math.max(0, (now - (row.updatedAt ?? now)) / 86_400_000)
    const freshness = Math.exp(-ageDays / 45)
    const importance = Math.max(0, Math.min(1, ((row.importance ?? 3) - 1) / 4))
    const usage = Math.min(1, Math.log1p(Math.max(0, row.hits ?? 0)) / 3)
    const score =
      WEIGHTS.coverage * coverage +
      WEIGHTS.tag * tagCoverage +
      WEIGHTS.phrase * (phrase ? 1 : 0) +
      WEIGHTS.freshness * freshness +
      WEIGHTS.importance * importance +
      WEIGHTS.usage * usage

    if (score < minScore) continue
    results.push({ ...row, score, matchedTerms: matched })
  }

  results.sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.id - a.id)
  return results
}

/**
 * 仅按更新时间排序（空查询 = 浏览最近记忆）。
 * @param {Array<object>} rows
 * @param {number} limit
 */
export function recentRows(rows, limit) {
  return [...rows]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.id - a.id)
    .slice(0, Math.max(0, limit))
}
