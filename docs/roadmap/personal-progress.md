# Episteme Personal 进度

最后更新：2026-11-02。

## 已完成（已提交 Draft PR，未合并）

- G0.2 个人仓 PR 检查：[#1](https://github.com/Jiarong-Song233/Episteme/pull/1)。
- G0.1 单 SQLite 存储基线和跨进程持有者测试：[#2](https://github.com/Jiarong-Song233/Episteme/pull/2)。
- 路线和计划文档：[#3](https://github.com/Jiarong-Song233/Episteme/pull/3)。
- G1 复用决策记录：[0001](../research/reuse-decisions/0001-learning-workbench.md)。
- G1.2、G1.3 材料和带引用问答：[#4](https://github.com/Jiarong-Song233/Episteme/pull/4)。
- G1.1、G1.4 空间、会话和候选路由：[#5](https://github.com/Jiarong-Song233/Episteme/pull/5)。
- G1.5 Web 界面和浏览器端到端测试：[#6](https://github.com/Jiarong-Song233/Episteme/pull/6)。
- G2 学习计划、工作流、速通和深入、练习和学习状态：`feat/workbench-plans`，复用决策 [0002](../research/reuse-decisions/0002-learning-workflows.md)。
- G3 理解的提出、质疑、修正、再利用，时间线和关系图：`feat/workbench-understanding`，复用决策 [0003](../research/reuse-decisions/0003-understanding.md)。
- G4 发布、引用、回应、谱系和浏览：`feat/workbench-sharing`，复用决策 [0004](../research/reuse-decisions/0004-sharing.md)。

## G1 验收

用户路径：启动服务 → 建空间 → 上传材料 → 带引用问答 → 审阅并保存理解 → 退出重启 → 找回材料、对话和理解。

- 自动化：`tests/workbench-web.test.ts` 用真实浏览器（系统 Edge 或 Chrome）走完整路径，含拒收文件、模型失败重试、删除材料、手机宽度。模型是模拟模型或桩。
- 真实演示（2026-11-02）：`serve.js` 进程接 magpie 网关的 `auto/deepseek-v4.1-flash`，合成笔记，Edge 操作页面，进程重启后三项都找回。回答 2 到 5 秒；无关问题 13 毫秒拒答，没有调模型。
- 真实演示发现、模拟测不出的缺陷，都已修复并补了回归测试：
  - 思考型本地模型把输出额度花完后正文为空。
  - 模型把角标写在句号前，句号被算成一句“推断”。
  - 短文档的引用会高亮整篇，改为定位到最接近的一句。
  - 机器上只有 `Source Han Serif SC` Heavy 字重时，整页变粗。

## G2 验收

用户路径：同一份材料分别走速通和深入 → 改计划 → 做题 → 收到反馈 → 暂停和恢复 → 看学习状态。下面都是我用脚本驱动浏览器做的，还没有真人用过。

- 自动化：`tests/workbench-plans.test.ts` 和 `tests/workbench-web.test.ts`，模型是模拟模型或桩。
- 真实演示（2026-11-02）：magpie 网关的 `auto/deepseek-v4.1-flash`，合成笔记，单次预算 50 次调用、12 万 token。速通 60 分钟 10 步走完，深入 30 分钟走到练习，手机宽度没有横向溢出。`EPISTEME_WORKFLOWS` 加的流程在真实进程里能选、能生成计划。
- 第一轮真实演示发现、模拟测不出的缺陷，都已修复：Markdown 粗体原样显示；模型只说“证据不足”但材料其实讲过；小标题被标成推断；模型复述指令；重点写成长句，开场白读不通。
- 第二轮真实演示里出现一次“模型没有返回内容”，页面保留进度，可以重发。没有自动重试。
- 模型会在深入对话里补充材料以外的知识（比如偶数维用正弦），这些句子标成了推断。标注靠模型自报，只校验角标是否存在和用词重合度。
- 练习题的“正确答案”由模型从摘录出题，没有人工校对；正确率只说明答题和这份答案的对照结果。

## G3 验收

用户路径：说出一个想法 → 确认为理解 → 被质疑 → 修正 → 新对话带出修正后的说法 → 从理解跳回原话 → 重启后轨迹还在。下面都是我用脚本驱动浏览器做的，还没有真人用过。

- 自动化：`tests/workbench-understanding.test.ts`（20 个，服务端）和 `tests/workbench-web.test.ts`（浏览器走完整轨迹，含矛盾、模型质疑、撤回和恢复），模型是模拟模型或桩。
- 真实演示（2026-11-02）：magpie 网关的 `auto/deepseek-v4.1-flash`，合成笔记，单次预算 20 次调用、6 万 token。整段提炼约 7 到 10 秒，模型质疑约 3 秒，引文都落在材料里。
- 第一轮真实演示发现、模拟测不出的缺陷，都已修复：模型把提问当成理解；同一句话因措辞略改出现两条待确认（去重后又用测试查出会挡住相反观点，改为否定词不同不算相近，人主动提出的从不拦）；列表按钮样式错误；手机上长标签居中。

## G4 验收

用户路径：林登录 → 确认一条理解 → 预览并发布 → 魏登录 → 搜索、阅读、引用 → 新对话带出这条，标明作者 → 魏提出自己的版本并发布 → 林看到回应、理由和差异，原文不变 → 林撤回。下面都是我用脚本驱动两个浏览器做的，还没有真人用过。

多人使用要自己启动（默认关闭）：`pnpm workbench add-person <名字> --users <文件>` 生成令牌，再用 `--shared --users <文件> --sharing` 启动。

- 自动化：`tests/workbench-sharing.test.ts`（10 个，服务端）和 `tests/workbench-sharing-web.test.ts`（两个浏览器上下文走完整路径，含错误令牌、换身份、撤回），模型是模拟模型。
- 真实演示（2026-11-02）：magpie 网关的 `auto/deepseek-v4.1-flash`，合成笔记，单次预算 20 次调用、6 万 token。验收路径走通，原文没有变。
- 真实演示发现、已修复的缺陷：单条成果标题和正文重复；差异上下两行重复原文；用词“分叉”太术语。写浏览器测试时发现：回应理由只在回应者的私人记录里，作者看不到。改为发布时预填到“说明”，由本人决定是否公开。

## G5 验收

验收标准：非学习场景不改 Core 就能审阅、保存、检索和复用认知成果；文档与接口真实可运行。

- 非学习场景：`apps/hypothesis`，约 140 行，Core 和 Application 的行为都没有改。没有页面，只有 REST 和 MCP。
- 导出恢复：`pnpm workbench export <文件> [--graph <文件>]` 和 `pnpm workbench import <文件> --graph <新文件>`。文件带来源、构建、版本和校验和；被改动或损坏的文件、更新的版本、正在使用的图都会被拒绝；绝不覆盖已有文件，只导入到新文件。
- 自动化：`tests/graph-export.test.ts`（材料、对话、理解、来源轨迹、发布内容往返，以及命令行）、`tests/hypothesis-scene.test.ts`（REST、MCP、SDK 读到同样的节点和状态，重启和导入后历史相同）。
- 真实宿主（2026-11-02）：Claude Code 2.1.316，模型路由到 `auto/deepseek-v4.1-flash`，默认场景和假设场景各跑通，见[记录](../testing/host-e2e-log.md)。elicitation：声明支持，`-p` 模式自动取消，草稿留在队列。交互模式和 Codex 没有验证。
- 真实宿主发现、mock 测不出的缺陷，已修复：已接受的主张被说成“没有记录过”，新会话的模型拒绝据此回答。
- 审计：[边界审计](../architecture/boundary-audit.md)。MCP 工具说明里的 learner 已改；已持久化的 `learn-surface`、`learn-review` 没改，因为需要迁移。PRD 提到的 `EvaluationPolicy` 在代码里不存在。
- SAIR：[候选贡献清单](sair-contribution-candidates.md)，只是提议，没有动团队仓。
- 决策：[0005](../research/reuse-decisions/0005-export-and-boundary.md)。

## 已知问题

- G5：导出是明文，含私人材料。导出时整个图读进内存，超大图没有测过。格式版本不一致直接拒绝，没有跨版本迁移。`session.ts` 忘记传场景时会静默用 `learnScene`。`recall` 的中文摘要写死，英文场景也会读到中文。带示例种子的图里，种子节点也算 `kept`。没有真人在 Claude Code 交互模式里走过 elicitation。

- G4：作者看不到谁引用了自己，这是有意的。引用了旧版本后再引用新版本，旧条目不会自动退出，要本人撤回。发布页不支持带上对话摘要。搜索只匹配标题的子串。Cookie 没有 Secure 标记，要跨机器用需要放在 HTTPS 反向代理后面，这种部署没有测过。第一次发布会备份图谱文件，之后更早的构建打不开这张图。作者撤回全部发布后，名字显示为“另一位用户”。

- G3：相近判断是词覆盖，不理解语义（见决策 0003）。被“不要”掉的候选，再次提炼时可能又出现。关系图没有缩放，节点到几百个会挤。G3 之前确认的节点没有来源记录，页面显示“来源未记录”。模型提炼的关系可能牵强，需要人判断。

- 仓库根目录没有 LICENSE，公开仓库缺许可证声明。要由仓库所有者决定。
- ADR 0018 仍为 proposed。
- `learn-scene.ts`、`LearnSession` 别名、`learnProfile` 和决定通道 `learn-review` 仍在代码里，工作台暂时依赖 `learnScene`。
- `docs/planning/mindlink-spec.md` 仍在仓库中，作为历史规划保留。
- 只有关键词检索，没有向量检索。没有和向量检索对比过效果。
- CJK PDF 提取未验证，夹具只有 ASCII。
- 模型预算只按单次运行计，重启后清零。
- 候选由回答句子直接生成，每句一条，没有合并或概念抽取。

## 下一步

G6 第一轮已跑，见[报告](../research/evaluation/round-1.md)。它只比了同模型基线，**与成熟产品的对比没有做**，要等用户点名授权运行某个项目。

接下来按报告第 9 节处理它发现的问题：相关性闸门、引用截断和对话步骤的空回复。
