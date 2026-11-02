# 复用决策记录 0001：G1 学习工作台

调查日期：2026-11-02。版本和提交是当日查到的，选定依赖以锁文件为准。

## 目标能力

本地可运行的学习工作台：解析 TXT、Markdown 和文本 PDF，切块并保留可定位来源，中英文检索，调用可配置模型做带引用的问答，提供最小 Web UI 和真实浏览器 e2e。

## 候选项目

| 项目 | 提交/版本 | 维护 | 许可证（看过 LICENSE 或 npm 元数据） | 与本目标的关系 |
| ---- | --------- | ---- | ---- | ---- |
| Mintplex-Labs/anything-llm | `9caf2b4c29` | 活跃 | MIT | 同类产品，Node 栈，工作区+引用的交互可参考 |
| lfnovo/open-notebook | `a0f6f3081a` | 活跃 | MIT | 同类产品，Python 栈，引用与 ask 流程可参考 |
| HKUDS/DeepTutor | `f7aed0744c` | 活跃 | Apache-2.0 | 学习导向，Python 栈，留给 G2/G6 比较 |
| open-webui/open-webui | `f7ac7ee109` | 活跃 | 自定义（BSD 式，加品牌保留条款），SPDX 为 NOASSERTION | 只作参考，不搬代码 |
| langgenius/dify | `5e3edb5f34` | 活跃 | 修改版 Apache（限制多租户和 LOGO），NOASSERTION | 只作参考，不搬代码 |
| infiniflow/ragflow | `2fb37b43f7` | 活跃 | Apache-2.0 | 依赖重型服务，不适合本地单文件 |
| run-llama/LlamaIndexTS | 2026-03 已归档 | 已归档 | MIT | 不选 |
| langchain-ai/langchainjs | `@langchain/textsplitters` 1.0.2 | 活跃 | MIT | 切块算法可参考；要拉 `@langchain/core` 和 `js-tiktoken`，且分块不给字符偏移 |
| unjs/unpdf | 2.1.0，`03f16f7c48` | 活跃 | MIT | 打包好的 pdf.js，无依赖 |
| mozilla/pdf.js（pdfjs-dist） | 6.5.438 | 活跃 | Apache-2.0 | 37 MB，unpdf 已封装 |
| lucaong/minisearch | 7.2.0，`3d239d1c3a` | 活跃 | MIT | 内存 BM25，无依赖，分词可替换 |
| asg017/sqlite-vec | 最近提交 2026-05 | 较慢 | Apache-2.0 | 向量检索，本切片不需要 |
| yanyiwu/nodejieba | 最近提交 2026-10 | 活跃 | MIT | 原生模块，需要编译；`Intl.Segmenter` 已够用 |
| openai/openai-node | 7.47.0，`aab204589e` | 活跃 | Apache-2.0 | 无依赖，内建超时和重试，兼容 OpenAI 协议的服务都能用 |
| vercel/ai | 7.0.159，`d05ff62360` | 活跃 | Apache-2.0（GitHub 显示 NOASSERTION，LICENSE 正文是 Apache-2.0） | 功能多，依赖树大，本切片用不上 |
| assistant-ui/assistant-ui | `a4dcbb5b91` | 活跃 | MIT | 聊天组件；我们需要逐句引用和来源面板，要大量定制 |
| react / vite | react 19.3.1；vite 见锁文件 | 活跃 | MIT | UI 与构建 |
| microsoft/playwright（playwright-core） | 1.64.1 | 活跃 | Apache-2.0 | 浏览器 e2e；core 包不下载浏览器 |
| honojs/hono | 4.13.16 | 活跃 | MIT | 服务路由迁移，不属于本切片 |

## 实现证据

- 工作区和引用的交互：anything-llm `frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/Citation/index.jsx`、`SourcesSidebar/`。
- 问答流程和引用规则：open-notebook `open_notebook/graphs/ask.py`、`prompts/ask/final_answer.jinja`、`docs/3-USER-GUIDE/citations.md`。
- 切块：open-notebook `open_notebook/utils/chunking.py`；anything-llm `server/utils/TextSplitter/index.js`；LangChain 的 `RecursiveCharacterTextSplitter`。
- PDF：unpdf 的 `extractText(pdf, { mergePages: false })` 按页返回文本。
- 检索：MiniSearch 的 `tokenize`、`processTerm` 选项；Node 内置 `Intl.Segmenter('zh', { granularity: 'word' })`。
- 模型：`new OpenAI({ baseURL, apiKey, timeout, maxRetries })`。

## 决策

| 能力 | 方式 | 选择 | 理由 |
| ---- | ---- | ---- | ---- |
| PDF 文本 | 直接依赖 | unpdf | 无依赖，MIT，按页取文本，页码正好用于定位 |
| 检索 | 直接依赖 | MiniSearch + `Intl.Segmenter` | 无依赖，内存索引可由持久化文本重建；FTS5 不分中文词，向量要额外模型 |
| 模型 | 直接依赖 | openai-node，隔在 `ModelClient` 接口后 | 覆盖 Ollama、DeepSeek、OpenRouter 等；可换 |
| 切块 | 参考重写 | 递归分隔符算法，约 80 行 | 引用要字符偏移，LangChain 的切分器不给，且会带入大依赖 |
| 问答和引用规则 | 参考重写 | 编号摘录 + 行内 `[n]` 标记，服务端校验 | 只参考做法，未复制代码；校验是我们自己的约束 |
| UI | 直接依赖 + 自研组件 | React + Vite，自写 CSS | 组件很少；assistant-ui 留待复杂度上来再评估 |
| 浏览器 e2e | 直接依赖 | playwright-core，用系统 Edge/Chrome | 不运行浏览器下载脚本 |
| 同类产品 | 仅参考 | 不复制 anything-llm、open-webui、dify 的代码或视觉 | 后两者有品牌条款；我们的差异在理解层 |

## 成本和风险

- 依赖增量：运行时 3 个无依赖包（unpdf、minisearch、openai），Web 构建期 react、vite，测试期 playwright-core。都没有新增构建脚本许可。
- unpdf 打包 pdf.js，升级跟随上游；隔在 `pdf.ts` 后。
- 内存索引在启动和首次查询时重建，材料极多时会慢。个人本地场景可接受，到瓶颈时换 sqlite-vec。
- 只有关键词检索，换一种说法可能查不到。已知限制，后续接现有 `EmbeddingAdapter` 做混合检索。

## 不做

不引入 LangChain、向量数据库、Hono 迁移或聊天组件库。这些以后有证据时再单独决策。
