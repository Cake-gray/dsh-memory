# 变更日志

## 1.0.0（2026-11-17）

首个版本。

- **存储**：`node:sqlite`（WAL）+ 单表 memories，`norm_hash` 去重，`expires_at` 过期，容量裁剪。
- **工具**：`memory_save` / `memory_search` / `memory_update` / `memory_forget` / `memory_stats` / `memory_export`。
- **自动召回**：`agent/pre-step` 注入来源为 `memory` 的用户消息；可按轮/按会话，可关，可调条数、门槛、字符上限。
- **系统提示词**：稳定的长期记忆使用说明，可关。
- **命令**：`/memory stats|list|search|forget|export|help`。
- **设置**：14 项 Schemastery 配置，全部 volatile，改完即时生效。
- **导出**：Markdown / JSON，带时间戳写入导出目录。
- **检索**：中文 2/3 字滑窗 + 停用字过滤 + IDF 加权 + 新鲜度/重要度/使用频率综合打分。
- **测试**：30 个用例（分词打分、数据库行为、插件注册、工具端到端、输出 schema、自动召回、命令、live config）。
- **安装**：bundle 形式装入 android profile，`--dump-config` 验证通过。

## 未发布

- 暂无。
