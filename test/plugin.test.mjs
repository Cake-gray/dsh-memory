import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config, name } from '../lib/index.js'

const root = mkdtempSync(join(process.env.HOME ?? '.', '.dsh-memory-plugin-test-'))
const originalHome = process.env.DSH_HOME
let revision = 0

/** 每个用例一个独立的 DSH_HOME，避免共享数据库。 */
function harness(config = {}) {
  revision += 1
  const home = join(root, `home-${revision}`)
  process.env.DSH_HOME = home
  const tools = new Map()
  const handlers = new Map()
  const sections = []
  const commands = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)), info() {} },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    inject(_deps, callback) {
      callback(ctx)
      return { dispose() {} }
    },
    get() {
      return undefined
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    commands: {
      register(command) {
        commands.push(command)
        return () => {}
      },
    },
  }
  apply(ctx, config)
  return { home, tools, handlers, sections, commands, warnings, ctx }
}

const exec = () => ({ signal: new AbortController().signal })

test.after(() => {
  rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
})

test('插件名与 Config 默认值', () => {
  assert.equal(name, 'dsh-memory')
  const parsed = Config({})
  const value = (field) => (field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field)
  assert.equal(value(parsed.enabled), true)
  assert.equal(value(parsed.autoRecall), true)
  assert.equal(value(parsed.recallLimit), 4)
  assert.equal(value(parsed.recallMinScore), 0.16)
  assert.equal(value(parsed.maxMemories), 5000)
  assert.equal(value(parsed.defaultKind), 'fact')
  assert.deepEqual(value(parsed.storePath), '')
})

test('注册 6 个工具、1 段系统提示词、1 个命令', () => {
  const h = harness()
  assert.deepEqual([...h.tools.keys()].sort(), ['memory_export', 'memory_forget', 'memory_save', 'memory_search', 'memory_stats', 'memory_update'])
  assert.equal(h.sections.length, 1)
  assert.equal(h.sections[0].name, 'plugin:dsh-memory')
  assert.equal(typeof h.sections[0].text, 'function')
  assert.ok(h.sections[0].text().includes('memory_search'))
  assert.equal(h.commands.length, 1)
  assert.equal(h.commands[0].name, 'memory')
})

test('工具：保存 → 检索 → 更新 → 统计 → 导出 → 删除', async () => {
  const h = harness({ recallMinScore: 0.1 })
  const save = h.tools.get('memory_save')
  const search = h.tools.get('memory_search')
  const update = h.tools.get('memory_update')
  const stats = h.tools.get('memory_stats')
  const exportTool = h.tools.get('memory_export')
  const forget = h.tools.get('memory_forget')

  const saved = await save.execute({ content: '用户喜欢周五晚上吃火锅', kind: 'preference', tags: ['饮食', '周末'], importance: 4 }, exec())
  assert.equal(saved.duplicate, false)
  assert.equal(saved.total, 1)
  const dup = await save.execute({ content: '用户喜欢周五晚上吃火锅', importance: 5 }, exec())
  assert.equal(dup.duplicate, true)
  assert.equal(dup.id, saved.id)

  const found = await search.execute({ query: '火锅' }, exec())
  assert.equal(found.count, 1)
  assert.equal(found.matches[0].id, saved.id)
  assert.ok(found.matches[0].score > 0)
  assert.equal(found.matches[0].tags.includes('饮食'), true)

  const updated = await update.execute({ id: saved.id, importance: 5, tags: ['饮食'] }, exec())
  assert.deepEqual(updated.fields.sort(), ['importance', 'tags'].sort())

  const summary = await stats.execute({}, exec())
  assert.equal(summary.total, 1)
  assert.ok(summary.dbPath.endsWith('memory.sqlite'))
  assert.ok(summary.byKind.some((row) => row.kind === 'preference'))

  process.env.DSH_HOME = h.home
  const exported = await exportTool.execute({ format: 'markdown' }, exec())
  assert.equal(exported.count, 1)
  assert.ok(existsSync(exported.path))
  const text = readFileSync(exported.path, 'utf8')
  assert.ok(text.includes('火锅'))

  const removed = await forget.execute({ ids: [saved.id] }, exec())
  assert.equal(removed.removed, 1)
  assert.equal(removed.total, 0)
})

test('所有工具的输出都通过自己的 output.schema 校验', async () => {
  const h = harness({ recallMinScore: 0.1 })
  const save = h.tools.get('memory_save')
  const saved = await save.execute({ content: '输出校验用记忆', kind: 'todo', tags: ['测试'], importance: 2 }, exec())
  const calls = [
    ['memory_save', { content: '第二条', kind: 'fact' }],
    ['memory_search', { query: '记忆' }],
    ['memory_search', {}],
    ['memory_update', { id: saved.id, importance: 3 }],
    ['memory_stats', {}],
    ['memory_export', { format: 'json' }],
    ['memory_forget', { ids: [saved.id] }],
  ]
  for (const [toolName, args] of calls) {
    const tool = h.tools.get(toolName)
    const value = await tool.execute(args, exec())
    const violations = validateJsonSchemaValue(tool.output.schema, value, '')
    assert.deepEqual(violations, [], toolName + ' 输出不符合 schema：' + JSON.stringify(violations))
  }
})

test('live config：修改普通配置对象后立即生效', async () => {
  const config = { recallLimit: 2, autoRecall: true }
  const h = harness(config)
  const before = h.sections[0].text()
  assert.ok(before.includes('memory_search'))
  config.guidance = false
  assert.equal(h.sections[0].text(), '')
  config.guidance = true
  config.autoRecall = false
  const decision = { kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: '火锅' }], source: { kind: 'user' } }] }
  const agent = { session: { seq: 1, eventAt: () => ({ type: 'turn/start', data: {} }) } }
  await h.tools.get('memory_save').execute({ content: '喜欢火锅' }, exec())
  const out = await h.handlers.get('agent/pre-step')({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => decision)
  assert.equal(out.messages.length, 1)
})

test('工具参数校验给出中文错误', async () => {
  const h = harness()
  const save = h.tools.get('memory_save')
  await assert.rejects(() => save.execute({ content: '   ' }, exec()), /content 不能为空/)
  await assert.rejects(() => save.execute({ content: 'x', importance: 9 }, exec()), /1-5/)
  await assert.rejects(() => save.execute({ content: 'x', kind: 'nope' }, exec()), /INVALID_ARGS|kind/i)
  const forget = h.tools.get('memory_forget')
  await assert.rejects(() => forget.execute({ ids: [] }, exec()), /至少/)
})

test('自动召回：相关记忆作为 memory 来源的用户消息注入', async () => {
  const h = harness({ recallMinScore: 0.1 })
  await h.tools.get('memory_save').execute({ content: '用户喜欢周五晚上吃火锅，偏好微辣', kind: 'preference', tags: ['饮食'], importance: 5 }, exec())
  const decision = {
    kind: 'continue',
    messages: [{ role: 'user', content: [{ type: 'text', text: '这个周末想吃火锅，帮我找一家店' }], source: { kind: 'user' } }],
  }
  const agent = {
    session: {
      seq: 1,
      eventAt(index) {
        return index === 0 ? { type: 'turn/start', data: { turn: 1 } } : undefined
      },
    },
  }
  const call = h.handlers.get('agent/pre-step')
  const out = await call({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => decision)
  assert.equal(out.messages.length, 2)
  const injected = out.messages[1]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.kind, 'memory')
  assert.ok(injected.content[0].text.includes('火锅'))
})

test('自动召回只取真实用户消息，忽略 time-context 等运行时上下文', async () => {
  const h = harness({ recallMinScore: 0.05 })
  await h.tools.get('memory_save').execute({ content: '用户喜欢火锅' }, exec())
  const decision = {
    kind: 'continue',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好，今天怎么样' }], source: { kind: 'user' } },
      { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1: 火锅 timezone' }], source: { kind: 'time-context' } },
    ],
  }
  const agent = { session: { seq: 1, eventAt: () => ({ type: 'turn/start', data: {} }) } }
  const out = await h.handlers.get('agent/pre-step')({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => decision)
  assert.equal(out.messages.length, 2)
})

test('自动召回：关闭开关 / 本轮已注入时不再注入', async () => {
  const h = harness({ autoRecall: false })
  await h.tools.get('memory_save').execute({ content: '用户喜欢火锅' }, exec())
  const decision = { kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: '想吃什么' }], source: { kind: 'user' } }] }
  const agent = { session: { seq: 1, eventAt: () => ({ type: 'turn/start', data: {} }) } }
  const out = await h.handlers.get('agent/pre-step')({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => decision)
  assert.equal(out.messages.length, 1)

  const h2 = harness({ recallMinScore: 0.05 })
  await h2.tools.get('memory_save').execute({ content: '用户喜欢火锅' }, exec())
  const agent2 = {
    session: {
      seq: 2,
      eventAt(index) {
        if (index === 1) return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '[记忆]' }], source: { kind: 'memory' } } }
        return { type: 'turn/start', data: {} }
      },
    },
  }
  const out2 = await h2.handlers.get('agent/pre-step')({ agent: agent2, turn: 1, step: 1, signal: new AbortController().signal }, async () => decision)
  assert.equal(out2.messages.length, 1)
})

test('enabled=false 时工具拒绝执行、说明不注入', async () => {
  const h = harness({ enabled: false })
  await assert.rejects(() => h.tools.get('memory_stats').execute({}, exec()), /已.*关闭|enabled/)
  assert.equal(h.sections[0].text(), '')
})

test('/memory 命令：stats / list / search / forget / export', async () => {
  const h = harness()
  await h.tools.get('memory_save').execute({ content: '用户喜欢火锅' }, exec())
  const command = h.commands[0]
  const run = (rawInput) => command.handler({ rawInput, agent: {}, attachments: [], signal: new AbortController().signal })
  const stats = await run('stats')
  assert.equal(stats.kind, 'success')
  assert.ok(stats.text.includes('1 条'))
  const list = await run('list 5')
  assert.ok(list.text.includes('火锅'))
  const search = await run('search 火锅')
  assert.ok(search.text.includes('找到 1 条'))
  const help = await run('help')
  assert.ok(help.text.includes('/memory stats'))
  const exported = await run('export json')
  assert.ok(exported.text.includes('已导出'))
  const forget = await run('forget 1')
  assert.ok(forget.text.includes('已删除记忆 #1'))
})
