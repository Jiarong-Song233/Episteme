# 0018 — Terminal capture and an Obsidian client

2026-11-16。用于个人仓库的 capture 扩展，基于 ADR 0011（宿主提炼、引擎验引文）、0013（场景扩展）、0015（线程与 scope）、0020（提议路由权限）。不改 Core，也不改变既有 Workbench 的数据与路由。

## 问题

现有 CLI 原型把 commit 标题或宿主给出的短句直接变为 claim，缺少原文校验；只有学习场景有完整入口。分别启动 dev、Learn、discussion 服务还会争用同一图谱的唯一持有者。Obsidian 插件的 Learn 路径也没有对应路由。

## 采用

- 提供 `--scene capture` 组合 profile：公共词汇只注册一次，加入 dev 的 `validity` 和 discussion 的 `agreement`，复用 Learn 可记录维度。一个服务、一个 SQLite 文件容纳三个场景。原单场景入口兼容。
- 场景短笔记共享 `noteRoutes`：2–1000 字符，保存来源与原文，通过 `SceneView.distill` 的宿主候选路径验证引用。候选为 inferred，等人审阅；选中过一段文本不代表已经理解。
- `/notes` 显式列为 `proposingRoutes`，使真正的 agent 凭据可以提议；决定始终走既有 `/suggestions/decide`。共用 helper 使 dev、Learn、discussion 的验证和来源逻辑一致。
- CLI 的完整宿主阅读走 MCP `distill`，包括 quote/basis、关系、拒绝原因、submissionId 的重试收据；REST `/distill` 继续负责规则提炼，保持 ADR 0011 的边界。短数组和 git 模式是机械捕获，不把它们称为语义提炼。
- 原始讨论走已有 threads/turns。原文入档案、候选入队列、人的决定才进图；支持和矛盾可同时保留。`agreement` 记录本人对讨论一致程度的判断，不汇总投票或代替其他人的状态。
- scope 约定为 `scene:<dev|learn|discussion>[:<context>]`。列表按 scene 或完整 scope 筛选；recall 的 scope 保持排序偏好，不充当隐私边界。CLI 的 `--only-scope` 只筛选有限召回窗口，并明确输出其限制。
- Obsidian 插件只有命令、侧栏和设置；使用同一服务，不重做工作台。只安装三个产物，来源用 `obsidian://` 链接；token 由用户选择是否保存。插件不占用 `ItemView.setState` 的宿主生命周期方法。
- 三个宿主共用一个 capture skill 的发行副本，无自动 stop-hook。默认按相关任务召回，提炼少量可复用理解；人审阅。Installer 不改宿主配置，不覆盖不认识的工具。

## 验证

- `tests/capture-scene.test.ts`：三场景一个图谱，重启恢复，来源，真实 agent 的提议/拒绝决策边界，scope 和长度错误。
- `tests/cli.test.ts`：Learn 与讨论、状态和 compact recall、MCP 引文拒绝、矛盾关系、幂等重试、stdin 整批校验、dry-run、原文线程。
- `tests/capture-install.test.ts`：安装预览零写入、三个宿主的技能一致、不覆盖已有内容。
- `scripts/test-obsidian-epi.mjs`：真实 Notes vault 中执行提议与召回命令、点击确认/驳回、检验禁用按钮和服务错误。临时图谱与笔记已清理，设置只在内存中临时改变。
- 固定语料与检索边界见 [CLI recall 对照](../evaluation/cli-recall.md)。没有可用的真实嵌入端点，因此不宣称语义召回提升。

## 局限

- CLI/skill 的安装与协议闭环已验证；没有启动三个商业宿主各自调用付费模型做效果对比。技能是否被新会话采用，要看宿主的加载与调用规则。
- 没有真人学习效果或审阅负担数据。capture 是入口与溯源闭环，不提供自动真伪裁决。
- Dev/discussion 暂时复用 legacy 公共词汇，尚未与 MindLink 的后续词汇拆分同步；新 profile 不承诺 Workbench 学习工作流也使用这些维度。
- 组合 profile 通过注册公共词汇与新增维度读图，不改写旧图谱历史。含新增维度的图以后也应以组合 profile 或兼容其词汇的 profile 打开。
