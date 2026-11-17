# 长期记忆（dsh-memory）

> 一个给 DeepSeek Harness 的跨会话、可检索、可自动召回的本地长期记忆库。
> 数据保存在这台手机上的一个 SQLite 文件里；不需要联网，不需要向量数据库，不会把记忆上传到任何地方。
> 14 项设置全部支持在 DSH 的插件设置页里热更新；插件卸载/重启不会丢数据。

> 作者：蛋糕灰（GitHub: [Cake-gray](https://github.com/Cake-gray)） · 仓库：[dsh-memory](https://github.com/Cake-gray/dsh-memory) · 安装包见 [Releases](https://github.com/Cake-gray/dsh-memory/releases) · 许可证：MIT

---

## 一、它解决什么问题

我是运行在用户手机上的 DSH。我的会话是一次性的：这一轮里我可能刚刚弄清用户的口味、写代码的习惯、项目的目录结构、某个决定的前因后果，下一轮开新会话，这些就全没了。用户不得不反复交代同一件事，我也反复犯同样的错：忘记用户说过“不要用 pnpm”、忘记某个文件已经改过、忘记一个待办还没做完。子代理（subagent）和团队（agent team）同样各自失忆，主会话里定下的约定传不下去。

现有的插件各自解决别的问题：

- `dsh-council` 负责多模型评审与仲裁；
- `dsh-agent-teams` 负责多代理协作分工；
- `dsh-pilot` / `android-use` 负责操作电脑和手机；
- `dsh-web-search` 负责联网搜索；
- `dsh-subagent-registry` 负责把本地 agent 注册成可调用的子代理；
- `dsh-background` 负责把慢工具丢到后台；
- `dsh-plugin-guide` 是插件开发知识库。

它们都很好，但没有一个提供“跨会话记住事实、并在需要时自动想起来”的能力。`dsh-memory` 补的就是这一块：它是一个长期记忆库，而不是一次性上下文。它把“用户是谁、偏好什么、做过什么决定、有哪些经验与待办”沉淀成本机数据库里的条目，并在每一轮对话开始时，按当前问题自动挑出最相关的几条注入模型请求；同时给模型六个工具，让它能主动写入、检索、修正、删除、统计和导出记忆。

一句话：**它让“记住”从模型的临时上下文，变成这台手机上的一份持久资产。**

---

## 二、能力总览

| 能力 | 说明 |
| --- | --- |
| 持久存储 | 本机 SQLite 单文件（默认 `<DSH_HOME>/memory/memory.sqlite`），WAL 模式，读写快、崩溃后可恢复 |
| 六个工具 | `memory_save`、`memory_search`、`memory_update`、`memory_forget`、`memory_stats`、`memory_export` |
| 自动召回 | 每轮按用户消息检索相关记忆，作为来源为 `memory` 的“用户消息”注入本轮请求；可选只召回一次 |
| 系统提示词 | 一段稳定的“长期记忆使用说明”，提醒模型何时检索、何时保存、冲突时怎么办 |
| 人工命令 | `/memory stats`、`list`、`search`、`forget`、`export`，在聊天框直接敲 |
| 设置页 | 14 项设置，全部 volatile：保存即生效，不重启、不重建插件 |
| 去重与合并 | 相同正文只存一条；重复保存会合并标签、保留更高重要度 |
| 过期与裁剪 | 待办类记忆可以设过期天数；超过条数上限自动淘汰冷门旧条目 |
| 导出备份 | Markdown（人读）/ JSON（程序处理）两种格式，带时间戳写入导出目录 |
| 隐私 | 全部在本机；不联网、不调用模型、不上传；数据库可直接用 MT 管理器查看 |

---

## 三、安装与启用

### 3.1 已安装的现状

本插件已经安装进 `android` profile：

- 源码与文档：`/storage/emulated/0/好吃文件夹/插件/1/`
- 运行时包：`<DSH_HOME>/profiles/android/node_modules/dsh-memory/`
- profile 的 `dsh.profile.bundles` 已加入 `dsh-memory`
- 插件行 id：`dsh-memory`，由包内 `cordis.patch.yml` 插入

### 3.2 第一次启用

DSH 启动时才会装配 bundle。安装完成后需要**完全退出并重新打开 DSH**（不是新建会话），让 loader 读到新的 bundle 行。重启后：

1. 打开 DSH 的插件/扩展页面，应能看到「长期记忆」卡片（标题与描述来自 `locale/zh.json`，图标来自 `icon.svg`）；
2. 点进设置，能看到 14 个字段；默认值已经可用，直接保存或修改都可以；
3. 在任意会话里对模型说“记住：我周五晚上一般吃火锅”，它应当调用 `memory_save`；再开一个新会话问“我周五一般吃什么”，它应当先调用 `memory_search`，即使不检索，自动召回也会把这条带进上下文。

### 3.3 重新安装（换机/重装时）

推荐用 DSH 自己的扩展页安装（它会处理 pnpm 依赖、bundle 选择与启用）：

1. 打开 DSH 的「扩展 / 插件」页；
2. 选择「从本地文件安装」，指向
   `/storage/emulated/0/好吃文件夹/插件/1/dsh-memory-1.0.0.tgz`；
3. 安装完成后确认「长期记忆」处于启用状态；
4. 完全退出并重新打开 DSH。

不建议手动改 profile 的 `package.json` 或直接在 profile 目录里跑 pnpm：DSH 的插件管理器会维护 lockfile、bundle 层顺序与兼容性检查，手改容易产生“装了但没挂上”的假象。本机的安装记录见 `docs/安装与验证.md`。

---

## 四、六个工具

### 4.1 `memory_save` —— 写入

参数：

- `content`（必填，字符串）：记忆正文。要求自包含，例如“用户偏好周五晚上吃火锅，微辣”而不是“他喜欢那个”。长度受 `maxContentChars` 限制（默认 4000 字符）。
- `kind`：`fact`（事实）、`preference`（偏好）、`decision`（决定）、`lesson`（经验）、`todo`（待办）、`event`（事件）。省略时用设置里的 `defaultKind`（默认 fact）。
- `tags`：短标签数组，最多 12 个，单标签不超过 32 字符；用于检索加权与过滤。
- `importance`：1-5 的整数，默认 3；用户明确强调的长期偏好可以给 4-5。
- `expiresInDays`：多少天后过期；省略表示永不过期。适合“下周三交稿”这类待办。

返回：`{ id, duplicate, kind, importance, tags, total }`。`duplicate=true` 表示命中了去重：库中已有相同正文，插件把新标签并进去、保留更高的重要度，不会产生第二条。

### 4.2 `memory_search` —— 检索

参数：

- `query`：检索词。中文 2-4 个关键词效果最好；留空表示按更新时间浏览最近记忆。
- `kind` / `tags`：按类型、标签过滤（可选）。
- `limit`：1-50，默认用设置里的 `searchDefaultLimit`（8）。
- `minScore`：相关度门槛 0-1（可选）。
- `includeExpired`：是否包含已过期条目（默认 false）。

返回：`{ query, count, candidates, matches[] }`。每条 match 含 `id`、`content`、`kind`、`tags`、`importance`、`score`（0-1）、`hits`、`createdAt`、`updatedAt`、`expiresAt`。命中的条目会自动累加 `hits`，成为后续排序的“使用频率”信号。

### 4.3 `memory_update` —— 修正

参数：`id`（必填）加上任意要改的字段：`content`、`kind`、`tags`、`importance`、`clearExpiry`。只更新传入的字段；改正文会重新计算去重指纹。返回 `{ id, fields, total }`。信息变化时优先改旧条目，而不是再存一条新的。

### 4.4 `memory_forget` —— 删除

参数：`ids`（正整数数组，1-50 个）。硬删除，不可恢复。工具描述里明确要求：先 `memory_search` 核对 id，不要凭猜测删除；用户没有明确要求时不要删。

### 4.5 `memory_stats` —— 统计

无参数。返回总条数、总字符数、数据库路径与大小、最早/最新时间、已过期条数、各类型数量、热门标签。用于判断是否需要整理、导出或清理。

### 4.6 `memory_export` —— 导出

参数：`format`，`markdown`（默认，人可读）或 `json`（便于程序处理/迁移）。

导出到 `<DSH_HOME>/memory/exports/`（或设置里的 `exportDir`），文件名带 UTC 时间戳，例如 `memory-2026-11-17T06-30-00-000Z.md`。返回 `{ path, count, bytes, format }`。导出的 Markdown 按类型分组，附创建/更新时间与命中次数；JSON 是稳定结构，方便以后导入或迁移。

---

## 五、自动召回是怎么工作的

自动召回挂的是官方扩展点 `agent/pre-step`（waterfall）。每一轮模型请求之前，插件会：

1. 从会话中取出本轮用户消息（已进入会话的 + 本轮 proposed 的），去掉代码块、URL 和自动召回消息本身，清洗成查询文本；
2. 检查本轮（或整个会话，取决于设置 `recallEveryTurn`）是否已经注入过，避免重复；
3. 用检索算法挑出最多 `recallLimit` 条、分数不低于 `recallMinScore` 的记忆；
4. 把这些条目渲染成一段紧凑文本，通过 `createUserMessage` 生成一条 **source.kind = "memory"** 的用户消息，追加到本轮决策消息里。

这条消息会被 agent-loop 正常写进会话日志，所以在会话回放、压缩、导出里都能看到它——这正是 DSH 的“模型可见 ⟺ 已记录”约束。它不是偷偷改系统提示词，也不会让 prompt cache 失效。

几个边界：

- 没有相关记忆、查询为空、本轮已注入、`autoRecall=false`、插件被关闭时，都不注入；
- 召回失败（数据库打不开、SQLite 报错）只记一条 warning，**绝不阻断对话**；
- 召回条目的 `hits` 会累加，常用记忆以后更容易被召回；
- 自动召回只覆盖最相关的几条；模型需要更多时应自己调用 `memory_search`。

---

## 六、检索算法

### 6.1 为什么不用 FTS5

SQLite 内置 FTS5 的 `trigram` 分词器对两个汉字的词（“火锅”“周五”“杭州”）完全无法命中——它需要至少 3 个字符才能形成三元组。中文里两字词占绝大多数，所以直接用 FTS5 会“看起来能用，实际什么都搜不到”。而 `unicode61` 分词器会把一整段连续汉字当成一个 token，同样不可用。

记忆条数默认上限 5000，一次线性扫描加 IDF 加权的耗时在毫秒级，因此插件选择**自己做分词和打分**：简单、可测试、没有隐藏行为，也不依赖 SQLite 的编译选项。

### 6.2 查询分词

- 英文/数字按单词切，长度 ≥ 2 才保留；
- 中文按 2 字、3 字滑窗切二元/三元组，整段（≤ 8 字）也保留一份用于短语加成；
- 过滤“整词都是虚字”的二元组（例如“一下”“帮我”），减少噪声；
- 单字查询（如“猫”）保留单字，检索退化为子串命中。

### 6.3 打分

对每条候选记忆计算：

```
score = 0.55 * 内容命中覆盖率(按 IDF 加权)
      + 0.15 * 标签命中覆盖率
      + 0.10 * 整句短语命中
      + 0.06 * 新鲜度（45 天半衰期的指数衰减）
      + 0.09 * 重要度（1-5 映射到 0-1）
      + 0.05 * 使用频率（log(1+hits)）
```

IDF（文档频率的倒数）让“火锅”这种稀有词权重高、“用户”这种到处都是的词权重低，因此查询里出现一个独特关键词就能把正确条目顶上来。

覆盖率的分母只统计“记忆库里真实出现过”的词：一句自然语言（“帮我找一下周五晚上吃火锅的地方”）会带进十几个库里根本没有的词，如果把它们也算进分母，真正命中的“火锅”会被稀释到接近 0 分，自动召回就会整段漏掉。只按已知词归一化后，长句也能稳定命中；代价是弱相关的单字词命中也会排进候选，因此再用 `recallMinScore` 与 `recallLimit` 双重收敛。

分数落在 0-1 之间，方便用 `recallMinScore` 统一控制召回激进程度。

### 6.4 性能

- 5000 条 × 40 个词 × 子串匹配 ≈ 20 万次字符串比较，手机上通常 5-15 毫秒；
- 数据库使用 WAL，读不阻塞写；多进程（主进程、子进程）同时读写也安全；
- 没有后台轮询、没有定时器，插件空闲时零开销。

---

## 七、数据模型

```sql
CREATE TABLE memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT    NOT NULL,
  norm_hash   TEXT    NOT NULL,   -- 归一化正文的 sha256 前 32 位，用于去重
  kind        TEXT    NOT NULL DEFAULT 'fact',
  tags        TEXT    NOT NULL DEFAULT '[]',  -- JSON 字符串数组
  importance  INTEGER NOT NULL DEFAULT 3,
  source      TEXT    NOT NULL DEFAULT 'tool',
  created_at  INTEGER NOT NULL,   -- epoch 毫秒
  updated_at  INTEGER NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  expires_at  INTEGER             -- 为空表示永不过期
);
```

外加一张 `meta` 表用于未来的模式版本迁移，和三个索引（hash、kind、updated_at）。

**去重**：`norm_hash` 由“NFKC + 小写 + 压缩空白”后的正文计算，所以“用户喜欢火锅”和“ 用户喜欢火锅 ”视为同一条。重复保存时合并标签（取并集，最多 12 个）与重要度（取更大值），更新 `updated_at`。

**过期**：`expires_at` 是绝对时间。检索、统计默认排除已过期条目，`includeExpired=true` 可以看到；过期条目不会自动物理删除，直到被容量裁剪。

**裁剪**：保存后如果总数超过 `maxMemories`，按“重要度升序 → 从未命中优先 → 最久未更新”删除超出部分。用户真正在意的高重要度条目最不容易被淘汰。

---

## 八、设置项（14 项，全部热更新）

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | true | 总开关。关掉后工具拒绝执行、不自动召回、系统提示词说明也不注入；数据仍保留 |
| `storePath` | 空 | 数据库路径；空 = `<DSH_HOME>/memory/memory.sqlite`；可写绝对路径或 `~/...`；改后自动切换，旧库不删 |
| `autoRecall` | true | 是否自动召回 |
| `recallEveryTurn` | true | 每轮召回；关闭 = 每个会话只在第一轮召回一次，更省 token |
| `recallLimit` | 4 | 每轮最多召回几条（1-10） |
| `recallMinScore` | 0.16 | 召回门槛（0-1）。越高越严格 |
| `recallMaxChars` | 1200 | 单次召回注入文本上限（200-8000 字符） |
| `guidance` | true | 是否往系统提示词加使用说明 |
| `defaultKind` | fact | `memory_save` 未指定 kind 时的默认类型 |
| `maxMemories` | 5000 | 条数上限（100-100000） |
| `dedupe` | true | 保存时按正文去重并合并 |
| `maxContentChars` | 4000 | 单条正文最大字符数（200-20000） |
| `searchDefaultLimit` | 8 | `memory_search` 默认返回条数（1-50） |
| `exportDir` | 空 | 导出目录；空 = `<DSH_HOME>/memory/exports` |

说明：设置页由 DSH 根据 Schemastery Schema 自动生成，字段描述就是上表的“作用”。所有字段标记为 volatile，保存时通过 `loader/volatile-update` 写入运行中的配置对象，不需要重启，也不会重建数据库连接。

---

## 九、`/memory` 命令

在聊天框直接敲（不经过模型）：

```
/memory                       # 等同 stats
/memory stats                 # 规模、类型分布、热门标签、数据库路径
/memory list 20               # 最近 20 条
/memory search 火锅            # 检索
/memory forget 12             # 删除 #12（不可恢复）
/memory export                # 导出 Markdown
/memory export json           # 导出 JSON
/memory help                  # 帮助
```

命令返回的是直接 UI 文本，不会变成一条模型消息，也不会消耗 token。

---

## 十、隐私、备份与迁移

- **数据在哪**：默认 `<DSH_HOME>/memory/memory.sqlite`（本机 App 私有目录），加上 WAL/SHM 两个伴生文件；导出文件在 `<DSH_HOME>/memory/exports/`。
- **不联网**：插件不发起任何网络请求，不调用模型，不做上报；检索完全在本地完成。
- **备份**：`/memory export json` 或 `memory_export` 生成 JSON；直接复制 SQLite 文件也可以（先关掉 DSH 或使用 WAL 安全备份）。
- **迁移**：把 `memory.sqlite` 拷到新机器的同一路径，或修改 `storePath` 指向它；JSON 导出可用于跨格式迁移。
- **删除**：`memory_forget` 是硬删除；如果在意“删除痕迹”，删库后 SQLite 的 freelist 页仍可能残留文本，敏感场景请用 `VACUUM` 或重建库。
- **不要存什么**：密码、验证码、密钥、完整证件号、银行卡号。插件不阻止模型这么做，但系统提示词与工具描述都明确要求避免；用户发现后应让模型删除。

---

## 十一、为什么现有插件代替不了它

这不是“又一个工具箱”，而是把一条**跨会话、跨子代理、可审计**的记忆链路补齐：

1. **跨会话**：DSH 的上下文压缩与会话隔离会丢掉细节；记忆库在会话之外，下次新会话仍可检索。
2. **跨子代理**：主会话、子代理、团队共享同一个 SQLite 文件；主代理保存的偏好，子代理也能搜到。
3. **自动且可控**：不是把所有历史塞进提示词，而是按当前问题召回少量条目；条数、门槛、字符上限都可调。
4. **可修正、可删除、可导出**：记忆不是黑盒向量，是一条条带 id、类型、标签、重要度、时间的记录；模型能改、用户能删、能导出成 Markdown 阅读。
5. **可审计**：自动召回作为来源为 `memory` 的用户消息写进会话日志，回放时能看到“当时模型看到了哪几条记忆”。
6. **零依赖、零联网**：只用 Node 内置 `node:sqlite`，没有原生模块，没有向量库，没有外部服务；在 Android 上装得上、跑得动。

其他插件各自专注协作、搜索、设备控制；把“长期记忆”交给它们中的任何一个都会破坏单一职责，也无法获得上述跨会话与可审计特性。

---

## 十二、十个真实使用场景

**场景一：口味与生活习惯。** 用户说“我周五晚上一般吃火锅，微辣”。模型调用 `memory_save` 存成 preference，标签 `饮食/周末`，重要度 4。下周用户只问“今晚吃啥”，自动召回把这条带进来，模型直接给火锅店建议，不用再问一遍。

**场景二：技术偏好。** 用户说“这个项目别用 pnpm，用 npm；文件都放在 /storage/emulated/0/好吃文件夹/插件/ 下”。存成 preference + fact 两条，标签 `工程/路径`。之后任何会话里模型写命令前都会先检索到，不会又掏出一个 pnpm 命令。

**场景三：项目决定及其原因。** “我们把记忆库放在 SQLite 而不是 FTS5，因为中文两字词搜不到。”存成 decision，标签 `dsh-memory/检索`。过几天另一个子代理要改检索，先搜到这条，就不会把已经否决的方案又提一遍。

**场景四：待办跟进。** “下周三之前把插件介绍写到 5000 字。”存成 todo，`expiresInDays=7`。到期后自动从检索结果里消失，不会在半年后还被当成未完成事项。

**场景五：经验教训。** “这个 App 的设置入口在「我 → 设置 → 通用」，首页那个齿轮是广告。”存成 lesson，标签 `App/入口`。下次操作同一个 App，模型先搜到，少走三步弯路。

**场景六：子代理共享约定。** 主代理在会话里存下“用户要求所有回复用中文、结论先行”。子代理启动后检索同一个库，也能读到这条约定，不需要主代理在每次派发时重复粘贴。

**场景七：新会话恢复上下文。** 用户隔了两天开新会话：“接着上次那个插件继续。”自动召回把“上次做到哪、还差什么”带回上下文，模型不必让用户从头讲一遍。

**场景八：用户纠错后修正。** 用户说“不对，我现在改吃素了”。模型先 `memory_search` 找到旧偏好，再 `memory_update` 改正文或把重要度调低，而不是简单再存一条互相矛盾的新记忆。

**场景九：导出与备份。** 用户要换手机，执行 `/memory export json`，得到一个带时间戳的 JSON；拷到新机后按同样结构导入即可。也可以直接复制 `memory.sqlite`。

**场景十：审计“它到底记得什么”。** 用户不放心，执行 `/memory list 50` 或 `/memory search 关键词`，逐条查看、删除错误条目。记忆不是黑盒：每条都有 id、类型、标签、重要度和时间。

这些场景共同说明一件事：记忆的价值不在“存了多少”，而在“需要的时候能不能被想起来、能不能被修正、能不能被检查”。dsh-memory 的三个设计（自动召回、id 可编辑、导出可读）就是围绕这三点做的。

## 十三、故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 插件页看不到「长期记忆」 | 没重启 DSH；或 profile 的 `dsh.profile.bundles` 没加 `dsh-memory`；检查 `--dump-config` 里有没有 `id: dsh-memory` |
| 工具调用报“无法打开记忆数据库” | `storePath` 指向了不可写目录，或磁盘满；改回空值使用默认路径 |
| 自动召回从不出现 | `autoRecall` 被关、`enabled` 被关、`recallMinScore` 太高、记忆库为空，或本轮消息太短没有可用关键词 |
| 召回内容过时 | 用 `memory_update` 修正，或调高 `recallMinScore` / 降低 `recallLimit`；旧条目可以用 `memory_forget` 删除 |
| 记忆库越来越大 | 调低 `maxMemories` 让插件自动裁剪，或手动导出后删库；`memory_stats` 看字符数与文件大小 |
| 设置改了没生效 | 本插件全部字段 volatile，正常应即时生效；若没有，确认修改的是 `dsh-memory` 这个条目而不是别的行；必要时重启 DSH |
| 想确认数据库内容 | 用 MT 管理器打开 `memory.sqlite`，或 `/memory export json` 后阅读导出文件 |

---

## 十四、代码结构

```
插件/1/
├── package.json          # 包清单：bundle patch、peer 依赖、导出、图标
├── cordis.patch.yml      # 插入 id=dsh-memory 的插件行
├── icon.svg              # 插件页图标（≤256 KiB，包内相对路径）
├── locale/
│   ├── zh.json           # 中文标题/描述
│   └── en.json           # 英文标题/描述
├── lib/
│   ├── index.js          # 插件入口：注册工具/提示词/命令/自动召回
│   ├── config.js         # Schemastery 设置 Schema + live getter + DSH_HOME 解析
│   ├── store.js          # SQLite 存储：保存/检索/更新/删除/统计/裁剪
│   ├── search.js         # 纯函数检索打分（IDF + 覆盖率 + 新鲜度…）
│   ├── text.js           # 归一化、分词、截断、URL/代码块清洗
│   ├── recall.js         # 自动召回、系统提示词说明、召回消息构造
│   ├── tools.js          # 六个 defineTool 工具定义
│   ├── command.js        # /memory 人工命令
│   └── export.js         # Markdown / JSON 导出
├── test/
│   ├── search.test.mjs   # 分词与打分单测
│   ├── store.test.mjs    # 数据库行为单测（含持久化/裁剪/过期）
│   └── plugin.test.mjs   # 注册、工具端到端、自动召回、命令、输出 schema 校验
├── docs/
│   └── 安装与验证.md      # 本次安装的验证记录
├── README.md             # 本文
├── CHANGELOG.md
└── LICENSE
```

运行时只用 Node 内置模块（`node:sqlite`、`node:crypto`、`node:fs`、`node:path`）和 DSH 以 peerDependency 提供的三个包（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`）。不引入任何第三方运行时依赖。

---

## 十五、测试与验证

```sh
cd /storage/emulated/0/好吃文件夹/插件/1
node --test test/*.test.mjs
```

覆盖：

- 中文二元词、短语、单字、英文单词的检索与排序；
- 去重、合并标签、更新、删除、过期过滤、容量裁剪、持久化重开；
- 工具注册数量与名称、系统提示词注册、命令注册；
- 六个工具端到端调用，并用 `validateJsonSchemaValue` 校验每个工具的输出都符合自己的 `output.schema`；
- 自动召回注入消息的 role/source/内容，开关关闭、已注入去重；
- `enabled=false` 时工具拒绝、提示词为空；
- live config 改动立即生效。

本次安装还做了 profile 级验证：`dsh --profile android --dump-config` 能组合出 `id: dsh-memory` 的行，包被安装到 `profiles/android/node_modules/dsh-memory`，bundle 列表包含 `dsh-memory`。详细记录见 `docs/安装与验证.md`。

---

## 十六、限制与路线图

当前版本的边界：

- 检索是关键词 + IDF，不是语义向量；换说法（“吃辣”vs“火锅”）可能搜不到，需要模型换关键词或用户补充标签。
- 自动召回每轮最多一次，超长对话里的旧细节仍可能被压缩掉，需要模型主动 `memory_search`。
- 没有“多用户/多租户”隔离：这是单用户手机上的单库。
- 导出没有配套的“导入”工具（JSON 结构稳定，可手工或脚本导入）。
- 删除是硬删除，没有回收站。

后续可以做的：导入工具、按会话/项目分区、自动从“用户明确要求记住”的消息里提取候选记忆（需用户确认）、更强的中文同义词扩展、在插件设置页显示数据库当前大小（只读状态行）。

---

## 十七、变更日志

### 1.0.0（2026-11-17）

- 首个版本：SQLite 存储、六个工具、自动召回、系统提示词说明、`/memory` 命令、14 项热更新设置、Markdown/JSON 导出。
- 针对 Android / Node 24 的 `node:sqlite`（WAL）实现，无原生依赖。
- 中文分词（2/3 字滑窗 + 停用字过滤）与 IDF 加权打分。
- 完整单测与 profile 级安装验证。

---

## 十九、常见问题（FAQ）

**问：它会自动把整段对话存下来吗？**
不会。只有模型显式调用 `memory_save` 才会写入；自动召回只读不写。这样记忆库保持精简，也避免把隐私内容无意识地沉淀下来。

**问：为什么模型有时候不保存我说的重要信息？**
模型是否调用工具取决于它的判断和系统提示词。你可以直接说“记住：……”，或让模型“把这条存进长期记忆”。如果它经常忘，检查设置里的 `guidance` 是否为 true，以及当前模型是否支持工具调用。

**问：自动召回会不会很费 token？**
默认每轮最多 4 条、总量不超过 1200 字符，约为几百个 token；把 `recallEveryTurn` 关掉后每个会话只召回一次，成本更低。也可以在设置里把 `recallLimit` 调到 2、`recallMaxChars` 调到 600。

**问：多个 DSH 进程同时写会不会坏？**
SQLite 使用 WAL + `busy_timeout=3000`，单条写入是毫秒级，正常并发不会冲突；极端情况下后到的写会等待最多 3 秒。

**问：删掉的记忆还能恢复吗？**
`memory_forget` 是硬删除，没有回收站。重要数据请先 `/memory export json`。

**问：记忆库会无限增长吗？**
默认上限 5000 条，超出后按“重要度低、从未命中、最久未更新”自动淘汰；`memory_stats` 能看到当前条数与文件大小。

**问：可以在电脑版 DSH 用吗？**
可以。插件只依赖 Node 内置模块与 DSH 公共扩展点，桌面 profile 同样能装；默认路径跟随各自的 `DSH_HOME`。

## 十八、许可

MIT。见 `LICENSE`。
