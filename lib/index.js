/**
 * dsh-memory — 跨会话长期记忆（SQLite）。
 *
 * 组合：
 *  - 6 个模型工具：memory_save / memory_search / memory_update / memory_forget / memory_stats / memory_export
 *  - 自动召回：agent/pre-step 时按本轮消息检索少量相关记忆，作为来源为 memory 的用户消息注入（会写进会话日志）
 *  - 系统提示词：一段稳定的使用说明（可在设置里关掉）
 *  - 人工命令：/memory stats|list|search|forget|export
 *  - 14 个设置项：全部 volatile，改完即时生效，不需要重启
 *
 * 设计约束：
 *  - 所有注册都走 ctx.effect / ctx.on / ctx.inject；插件卸载时工具、命令、监听器、数据库连接一起回收；
 *  - 不新增会话事件类型，模型可见的自动召回走既有 user/message 通道（可回放、可审计）；
 *  - 不 import 任何 UI/transport 包；零运行时依赖（只用 node: 内置模块和 DSH 提供的 peer 包）。
 *
 * @module dsh-memory
 */

import { Config, liveConfig, resolveDshHome } from './config.js'
import { MemoryStore } from './store.js'
import { createTools } from './tools.js'
import { registerMemoryCommand } from './command.js'
import { guidanceText, maybeRecall } from './recall.js'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-memory'

/** 只强依赖工具注册表；systemPrompt / commands 用 ctx.inject 可选接入。 */
export const inject = ['tools']

export { Config }

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config apply 收到的原始 Config（字段可能是 Volatile 引用）
 */
export function apply(ctx, config) {
  const dshHome = resolveDshHome(ctx)
  const cfg = liveConfig(config, { dshHome })

  /** 惰性打开的数据库连接；storePath 改了会自动切换。 */
  const state = { store: null, path: null }
  const getStore = () => {
    const path = cfg.storePath
    if (state.store === null || state.path !== path) {
      state.store?.close()
      state.store = new MemoryStore(path).open()
      state.path = path
    }
    return state.store
  }

  // 卸载时关闭数据库（WAL 落盘），不留后台句柄。
  ctx.effect(() => () => {
    state.store?.close()
    state.store = null
    state.path = null
  })

  for (const tool of createTools({ getStore, cfg })) ctx.tools.register(tool)

  // 系统提示词说明：设置里可关；文本在每次组装时读取当前配置。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'plugin:dsh-memory',
      order: 2350,
      text: () => (cfg.enabled && cfg.guidance ? guidanceText() : ''),
    })
  })

  // 人工命令 /memory（没有 commands 服务的组合里自动跳过）。
  ctx.inject(['commands'], (commandCtx) => {
    registerMemoryCommand(commandCtx, { getStore, cfg })
  })

  // 自动召回：先让其它监听器完成决策，再决定是否追加召回消息。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    return maybeRecall({
      agent: payload?.agent,
      decision,
      signal: payload?.signal,
      cfg,
      getStore,
      logger: ctx.logger,
    })
  })
}
