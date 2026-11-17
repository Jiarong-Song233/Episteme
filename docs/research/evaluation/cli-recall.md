# CLI recall 固定语料对照（P5）

2026-11-16，在 Windows、Node v24.21.0 上使用已有 `dist/` 实测。默认离线 lexical 的 top1 和 top3 均为 **6/18（33.33%）**，三个无答案问题均返回空结果。没有配置真实嵌入服务，**真实语义效果未验证**；这里没有人工桩向量的成绩，也没有调用远程付费模型。

## 复现

从仓库根目录运行，使用已安装的依赖和已编译的服务、application、core 包。本脚本不会编译仓库；共享目录中不要在评估期间替换 `dist/`。

```powershell
node scripts/evaluate-cli-recall.mjs
node scripts/evaluate-cli-recall.mjs --k 8
node scripts/evaluate-cli-recall.mjs --semantic
```

第一条默认 `k=3`，即使环境中已有 `EPISTEME_EMBEDDINGS_*` 也不调用嵌入端点。第三条只有显式指定 `--semantic` 才读取这些设置；缺配置时仍输出 lexical 结果，semantic 标为 `unverified`、`summary: null`。stdout 是完整 JSON，包括每道题、gold、排名、分数、贡献原因、分组指标、请求计数、清理结果和四个关键 dist 文件的 SHA-256。

可仅查看摘要，不产生结果文件：

```powershell
node scripts/evaluate-cli-recall.mjs | ConvertFrom-Json | ForEach-Object {
  $_.lexical.summary
  $_.semantic
  $_.requests
  $_.cleanup
}
```

若已在本机运行真实 Ollama 嵌入模型，可显式设置如下参数后运行；这只是复现配置示例，本次没有安装、下载或运行该模型。

```powershell
$env:EPISTEME_EMBEDDINGS_URL = 'http://127.0.0.1:11434'
$env:EPISTEME_EMBEDDINGS_MODEL = 'nomic-embed-text'
$env:EPISTEME_EMBEDDINGS_PROTOCOL = 'ollama'
$env:EPISTEME_EMBEDDINGS_TIMEOUT_MS = '10000'
node scripts/evaluate-cli-recall.mjs --semantic
```

也支持现有服务的 `openai` 和 `tei` 协议，以及 `EPISTEME_EMBEDDINGS_API_KEY`。脚本不输出设置值、服务的人类令牌、供应商原始报错或响应正文；模型标识仅输出 SHA-256。端点只接受 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP(S)，拒绝 URL 中的用户名、密码、查询和 fragment，所有请求禁止重定向。timeout 必须大于 0 且不超过 30000 毫秒。脚本不会安装或管理模型；本地代理背后是否转发至收费服务，需要运行者确认。本次实际没有调用这类代理。

## 语料、接口与计分

固定语料和题目直接定义在 [evaluate-cli-recall.mjs](../../../scripts/evaluate-cli-recall.mjs) 的 `CORPUS`、`CASES` 中，没有运行时生成或按成绩改题。语料包含 12 条英文 claim，三个题材各有两条目标、一条共享词汇但否定目标的干扰项、一条无关项。18 个正例每条只有一个 gold，分别用直接词汇、英文改写、中文跨语言问题检索；另有 3 个无答案问题。

| 题材 | 两条目标 | 干扰项 | 无关项 |
| --- | --- | --- | --- |
| dev | SQLite 批量写入的原子提交/回滚；退避加随机抖动 | 否定事务对原子写入的必要性 | CSS grid 布局 |
| learn | 注意力需要额外的位置信息；间隔重复改善长期记忆 | 声称注意力本身就能编码顺序 | 叶绿素与光合作用 |
| discussion | 多数赞成不能替代独立证据；达成共识仍保留异议及出处 | 声称多数表决能证明科学结论 | 周会时间地点 |

三个题材混在同一图中竞争，scenario 仅用于分组计分。它们不代表 dev/learn/discussion profile 的独立功能验收；脚本只依赖已有 `defaultProfile()`，不依赖正在变化的 profile、CLI 或 plugin 新接口。

执行顺序如下：

1. 在 `D:\Temp` 下用 `mkdtemp` 创建 `episteme-cli-recall-*` 目录。`startService({ graph, port: 0, host: '127.0.0.1', profile: defaultProfile(), embeddings: false })` 打开临时 SQLite。
2. 使用服务的人类令牌调用 `POST /api/v1/nodes`，走应用的 `addNode` 路径；再对每条节点调用 `POST /api/v1/record`，统一记录 `confidence: medium`。共 24 次本机 API 请求。没有边、scope boost、内置示例语料或用户已有图。
3. 关闭写入服务，再用已有公共 `CognitiveSession.open({ filePath, scene, weights })` 打开同一 SQLite，调用 `recall(question)`。lexical 权重为 1，其余 semantic/graph/cognitive/recency 均为 0，并断言返回规则和贡献原因符合此设置。
4. 关闭该会话；只有显式启用且配置有效时，才用 `startService({ ..., embeddings })` 重开同一 SQLite，通过 `POST /api/v1/recall` 跑相同题目。使用应用默认 hybrid 权重：semantic 0.5、lexical 0.2、graph 0.15、cognitive 0.1、recency 0.05；返回的实际规则也写入结果。
5. 所有服务和会话在 `finally` 关闭，再删除包含 SQLite、附属文件和锁的整个临时目录，并检查目录已不存在。成功 JSON 在清理完成后输出。捕获 SIGINT/SIGTERM 后中止后续请求并进入清理；操作系统强制终止或掉电无法保证执行 JavaScript `finally`。

不能把 `embeddings: false` 的默认 recall 直接叫 lexical：当前应用在没有外部 adapter 时仍创建 `DeterministicEmbeddingAdapter`。本脚本通过公共权重接口禁用其 semantic 信号，不调用它的 embed，也不计入任何人工语义成绩。lexical 是 **HybridRetriever 的纯 lexical 配置**，并非另一个算法 `LexicalGraphRetriever`。

`top1Hit` 表示 gold 在第一项；`topkHit` 表示 gold 在返回排名前 k 项。每题仅一个 gold，所以本题集的 top-k 命中率等于单 gold recall@k。无答案题不进入 18 题命中率的分母，单独统计 `absentEmpty`；`goldRank: null` 表示没有出现在返回列表中。应用最多返回 8 项，因此 `--k` 只允许 1–8。

若任何语义请求返回 `semanticUnavailable`，对应行 `valid: false`，命中字段为 null，保留标注后的回退排名供诊断，但整个 semantic 的 `summary` 为 null，不把回退算成语义成绩。即使所有 HTTP 请求成功，状态也只叫 `endpoint_evaluated`；协议响应无法证明后端采用真实训练模型，运行者必须另行核实模型名称、版本和来源，人工常量/规则向量不能作为语义效果。

## 实测结果

| 分组 | 正例数 | lexical top1 | lexical top3 | 真实嵌入 hybrid |
| --- | --- | --- | --- | --- |
| dev | 6 | 2/6 | 2/6 | 未验证 |
| learn | 6 | 2/6 | 2/6 | 未验证 |
| discussion | 6 | 2/6 | 2/6 | 未验证 |
| 直接词汇 | 6 | 6/6 | 6/6 | 未验证 |
| 英文改写 | 6 | 0/6 | 0/6 | 未验证 |
| 中文跨语言 | 6 | 0/6 | 0/6 | 未验证 |
| 总计 | 18 | 6/18 | 6/18 | 未验证 |

三个 `*-absent` 均返回 0 项。六个 `*-direct-*` 的 gold 均排第一，其余十二个正例均未返回 gold。`--k 8` 仍为 6/18。默认运行计数为 `serviceRequests: 24`、`embeddingRequests: 0`；清理记录包含 seed 服务和 lexical 会话均已关闭、`temporaryDirectoryRemoved: true`。

本次连续两次离线运行的完整 lexical 排名、分数、贡献原因和摘要逐项一致。固定题集 SHA-256 为 `d3a3608c8b4a079762658b5aee66066f94e0fa36aac97e1b4573b64d5700b5d9`，使用的关键编译产物如下。这四项用于识别此次主要实现，并不是所有传递依赖的完整指纹；源码 HEAD 不能替代编译产物版本。

| 编译产物 | SHA-256 |
| --- | --- |
| `packages/application/dist/session.js` | `d2ced42cc545ae82303b41a0692492fe6b1e0fa6ed2c8245d609e215490a1692` |
| `apps/service/dist/server.js` | `c81d894c1aaf29a5d33dc0ddd36b957453d78e051b27733a27d46f31c959bccd` |
| `apps/service/dist/profile.js` | `0259e7fdb780e14ed0222dbf105318c3d35ea7bdcbcbd59ceca3e5016f648bdd` |
| `packages/core/dist/retrieval/hybrid.js` | `1d4e8933ffc003280d80009266d579466d8d48c4744079ce71676f78196e6256` |

另外通过独立 Node 子进程检查了以下路径；没有生成额外仓库文件，也没有使用提供人工向量的服务：

- 默认模式下，即使设置嵌入 URL、模型和测试凭证，仍为零嵌入请求且不回显测试凭证。
- `--semantic` 缺配置时明确为 `no_embedding_service_configured`，无语义分数。
- 远程 URL 在请求前被拒绝，为 `only_loopback_endpoints_allowed`。
- 指向已关闭的随机本机端口时，21 次语义检索全部标为 `unavailable` 回退，semantic 摘要及每行命中字段为 null；服务关闭并清理文件。
- 在第一次 record 时注入失败，进程退出码为 1，错误中的测试敏感文本不输出，临时目录仍被删除。全部验证前后的 `D:\Temp\episteme-cli-recall-*` 目录集合一致。

静态检查命令为 `node --check scripts/evaluate-cli-recall.mjs`、`pnpm exec eslint scripts/evaluate-cli-recall.mjs`、`pnpm exec biome format scripts/evaluate-cli-recall.mjs`，均通过。未重编仓库，也未运行会触发全仓编译的 `pnpm test` / `pnpm check`。

## 结论边界

这组题故意包含少词汇重叠的改写题，不能用总分推断实际用户流量的命中率。12 条人工语料、单 gold、没有多跳和权限变化，不能代表大规模检索、回答准确率、延迟、统计显著性或产品优越性。中文题是在英文图上做跨语言查询，没有测中文材料分词。

当前 lexical 只做小写、分隔、去停用词及 label/tag/id 子串匹配，不理解否定、同义词或翻译；例如 `discussion-direct-1` 中的 `claim` 还会命中自动生成的 `claim_*` 节点 id，实际返回 8 项。干扰项可能因词汇重叠进入结果；同分再按创建时间和 id 排序。两次实测一致并不表示时间相关的平分策略在所有机器上都保证相同；公共接口没有注入固定 clock 的参数。

可选语义配置比较的是纯 lexical 与默认 hybrid，除了嵌入还恢复了 graph/cognitive/recency 权重，不是控制其他权重不变的纯 semantic 消融。统一状态和无边降低了部分差异，但创建时间仍可能影响 hybrid；应结合逐项 reasons 阅读结果。真实模型版本、嵌入宽度、服务器配置及运行环境也会改变结果。本次没有真实嵌入服务，因此只能确认离线基线、接口与失败报告路径，不能声称语义效果提升。

## PR #66 的 CI 失败（只读检查）

使用 `gh` 查看了 [run 43813951119 的 Ubuntu Node 22 作业](https://github.com/Jiarong-Song233/Episteme/actions/runs/43813951119/job/133121594553)，对应提交 `6df5c0b06c022cce3be387056eba56c1d75253e7`。

```powershell
gh run view 43813951119 --repo Jiarong-Song233/Episteme --json status,conclusion,headSha,jobs
gh api repos/Jiarong-Song233/Episteme/actions/jobs/133121594553/logs --allow-escape-sequences
```

`pnpm check` 在浏览器测试 `tests/workbench-vision-web.test.ts` 的 `opens every first-level page, follows real seed changes, confirms a candidate and saves an answer` 失败。第 378 行断言选中导航的 `aria-label` 应为“学习空间”，实际为“工作台”。总计 99 个测试文件中 98 通过、1 失败；920 个测试中 919 通过、1 失败。该作业的 `format:check` 因前一步失败而跳过；Windows Node 24 和 Ubuntu Node 24 均通过。安装时的未编译 bin ENOENT 警告不是这次退出码 1 的原因。

具体根因是测试的等待条件写成了**字符串形式的箭头函数**：第 368、372 行的 `page.waitForFunction` 收到的是字符串而不是真正函数。核对失败提交的测试文件及安装的 Playwright 实现可见，客户端发送 `isFunction: false`；服务端对该字符串 `eval` 得到函数对象，在 false 分支不调用函数体，然后因函数对象为 truthy 立即结束等待。`data-page` 和选中导航实际都没有被等待，随后普通 Vitest `expect(...).toBe(...)` 只读一次，于是浏览器尚未切换时读到了旧的“工作台”。这解释了与调度时机有关的单矩阵失败，不构成 Node 22 检索故障的证据。修复方向是传实际回调或改用真正等待目标 DOM 属性的断言；本任务只读检查，没有修改测试或 CI。
