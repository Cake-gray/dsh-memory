/**
 * 文本工具：归一化、分词、截断。
 *
 * 这个模块不依赖任何 DSH/第三方包，可以被单元测试直接导入。
 * 设计目标：中文（无空格）与英文都能得到可用的检索词，并且打分是纯函数、可复现。
 */

/** 中日韩统一表意文字与假名、谚文区间。 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/**
 * 兜底归一化：NFKC + 小写 + 压缩空白。
 * @param {unknown} input 任意输入
 * @returns {string} 归一化后的文本（永不抛错）
 */
export function normalizeText(input) {
  return String(input ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 文本中是否包含中日韩字符。 */
export function hasCjk(input) {
  return CJK_CHAR.test(String(input ?? ''))
}

/**
 * 按字符（而非字节）截断，超出时补一个省略号。
 * @param {unknown} input 原文
 * @param {number} max 最大字符数
 */
export function truncate(input, max) {
  const text = String(input ?? '')
  if (!Number.isFinite(max) || max <= 0) return ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * 中文单字停用集合：只用于过滤“整词都是虚字”的二元组，避免把“一下”“帮我”“的是”当成检索词。
 * 它不影响正常的实词二元组（例如“火锅”“周五”）。
 */
const STOP_CHARS = new Set(
  '的了是我你他她它们在有和与这那不吗呢吧啊要把被给对从到为以及或而但并让请帮找一下个上中去做用好几再先说看想要能会就都也很没别再又还只'.split(''),
)

/** 拉丁词（含数字、下划线、加号、连字符、点）的最小长度。 */
const LATIN_MIN = 2

/**
 * 把查询切成检索词：
 * - 英文/数字按单词切；长度 >= 2 才保留。
 * - 中文按 2~3 字滑窗切二元/三元组，整段（<= 8 字）也保留一份，用于短语加成。
 * - 过滤“全虚字”的二元组；结果去重并按出现顺序截断到 cap 个。
 *
 * @param {string} query 查询文本
 * @param {number} [cap=40] 最多返回多少个词
 * @returns {string[]} 检索词（已做 NFKC 小写归一化）
 */
export function queryTerms(query, cap = 40) {
  const norm = normalizeText(query)
  if (norm === '') return []
  const terms = []
  const seen = new Set()
  const push = (term) => {
    const single = typeof term === 'string' && term.length === 1 && /[\u3400-\u9fff]/u.test(term)
    if (typeof term !== 'string' || (term.length < LATIN_MIN && !single) || seen.has(term)) return false
    if (terms.length >= cap) return false
    seen.add(term)
    terms.push(term)
    return true
  }

  for (const match of norm.matchAll(/[a-z0-9][a-z0-9_+\-.]{1,}/gu)) push(match[0])

  for (const run of norm.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      // 单字查询无法做二元组；保留整字，让上层退化为子串匹配。
      if (/^[\u4e00-\u9fff]$/u.test(run)) push(run)
      continue
    }
    for (let n = 2; n <= 3; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const gram = run.slice(i, i + n)
        if (n === 2 && [...gram].every((ch) => STOP_CHARS.has(ch))) continue
        push(gram)
      }
    }
    if (run.length >= 2 && run.length <= 8) push(run)
  }
  return terms
}

/**
 * 从消息文本中提取“适合做记忆检索”的查询文本：
 * 去掉围栏代码块、URL、多余空白，截断到上限。
 * @param {string} text 原始消息
 * @param {number} [maxChars=1200] 输出上限（字符）
 */
export function recallQueryFrom(text, maxChars = 1200) {
  const cleaned = String(text ?? '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/https?:\/\/[^\s，。；、）】]+/gu, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return truncate(cleaned, maxChars)
}

/**
 * 把 epoch 毫秒格式化为稳定的 UTC 文本（避免时区/语言环境差异导致测试与回放不一致）。
 * @param {number|null|undefined} ms
 */
export function isoOf(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z')
}

/**
 * 数字裁剪：把任意数值夹到 [min,max]；非有限数返回 fallback。
 */
export function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
