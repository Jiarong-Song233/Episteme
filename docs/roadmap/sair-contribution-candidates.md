# 可回馈 SAIR 的候选贡献清单

**只是提议。** 没有修改 SAIR 仓库，没有提交 PR，也没有在 Issue 下评论。是否贡献、怎么拆分，由项目负责人决定。

筛选标准：对任何场景都有用，不依赖个人版工作台的产品决定，有测试。

| 候选 | 内容 | 所在位置 | 依赖和注意 |
| ---- | ---- | ---- | ---- |
| 宿主测试结果 | SAIR #32 问的问题：Claude Code 2.1.316 能连接、声明 elicitation、无头模式自动取消、提议者身份正确 | [`docs/testing/host-e2e-log.md`](../testing/host-e2e-log.md)、`scripts/host-e2e.mjs` | 用的是非 Anthropic 模型路由，且未测交互模式；团队版代码可能不同，需要在团队仓复跑 |
| `recall` 的 `kept` 语义修复 | 已接受但未标记程度的节点不再被说成“没有记录”。这是真实宿主才暴露的缺陷 | `packages/application/src/session.ts`、`packages/mcp/src/server.ts` | 改了 golden 期望。团队可能想用别的字段名 |
| MCP 工具说明中性化 | “the learner” 改为 “the person”，线上参数不变 | `packages/mcp/src/*.ts` | 只改文字，风险最低 |
| 图谱导出和导入 | 单文件、校验和、版本检查、绝不覆盖、只导入到新文件 | `packages/storage-sqlite/src/portable.ts` | 依赖 SQLite-only 存储（个人版 PR #2）。团队仓存储不同就需要改写 |
| 非学习场景示例 | 证明 `SessionScene` 和 `SceneProfile` 够用 | `apps/hypothesis/` | 作为示例或测试夹具比作为产品更合适 |
| 边界审计 | 通用层学习词汇的清单和分级 | [`docs/architecture/boundary-audit.md`](../architecture/boundary-audit.md) | 行号和计数需要在团队仓重新核对 |
| MCP README 工具表 | 4 个工具补到 9 个 | `packages/mcp/README.md` | 文档修正 |

## 不建议回馈

个人工作台的页面、学习计划、速通和深学流程、共享页面：这些是个人版的产品决定，不属于通用能力。
