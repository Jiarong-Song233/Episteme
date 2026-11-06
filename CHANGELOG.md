# 更新日志

本文件记录 Episteme 各版本中使用者能感知到的变化。版本号遵循语义化版本，目前处于 0.x 阶段：次版本号带来新能力，修订号只用于修复。条目依据 `git log` 整理，详细说明见各版本的发布说明。

## [Unreleased]

### 新增

- **工作台的页面有了地址**：空间、对话、学习计划、公开成果和右栏内容都写进地址，刷新、浏览器后退和粘贴链接都能回到同一处。地址里只有编号，不含引用原文。
- **空间先打开概览页**：回到一个空间，先看到等你确认的内容、缺口和最近一次学习结果；原来右栏的“学习状态”并入这一页。还没有任何内容的新空间直接进入提问页。
- **待确认和我的理解成为独立页面**：左边多了这个空间的导航（概览、学习、待确认、我的理解），数字随时显示还有几条等你确认。在对话里提炼或标记“这是我的理解”后，留在原来的对话里，不再自动跳走。右栏只在看引用原文时打开，可以随时关上；旧链接里的 `?side=pending` 等会自动转到新页面。
- **材料有了自己的页面**：导航里的“材料（n）”列出每份材料的类型、字数、段数、版本和加入日期，上传、换成新版本和删除都在这里；点材料名在右边看原文。左栏不再重复列出文件，新对话里还没有材料时有“去上传材料”。
- **页面更清楚**：概览里的“去确认”和“回到上次的学习”成为按钮；空间里已有学习计划时，新建计划的表单收在“新建学习计划”后面，左栏不再被表单撑长。
- **可以安装成桌面应用**：在 Edge 或 Chrome 里打开工作台，选“安装”，以后从开始菜单或程序坞打开独立窗口。窗口只保存页面本身；材料和理解每次都从服务读取，浏览器不留副本。服务没开时，窗口会说连不上服务，并提供“重试”，回到窗口时也会自动再试。
- **新的外观**：工作台换成更安静的配色和无衬线字体，左栏和页面分成两块圆角面板，数量显示成小标记，等你确认的条目用强调色标出；深色模式一并调整。应用图标也换了新样子。
- **“接入 Agent”页面**：左栏底部的“接入 Agent”列出这台电脑上的 MCP 地址，以及 Claude Code、Codex 和其他 MCP 客户端的接入命令，点“复制”即可。Agent 接入后只能读取和提出候选，确认仍然只能由你在“待确认”里完成。使用模拟模型时，顶部提示也会指向这个页面。
- **桌面程序**（`apps/desktop`，Tauri）：安装包自带 Node 运行环境和学习工作台，打开即在本机 `127.0.0.1:4322` 启动服务。关掉窗口时留在托盘，Agent 仍然连得上；托盘菜单可以设置开机启动，选“退出 Episteme”才停下服务。程序意外退出时服务也会跟着停下，不会一直占着图谱。只能运行一个实例；端口被别的程序占用时会说明原因。
- **一行命令安装**：`scripts/install.ps1`（Windows）和 `scripts/install.sh`（macOS、Linux）从最新发布版本下载安装包，校验 `SHA256SUMS` 后只为当前用户安装；设置 `EPISTEME_CONNECT=claude,codex` 时顺便接入 Claude Code 和 Codex。[docs/install.md](docs/install.md) 里有可以直接发给 Agent 的安装说明。
- **在工作台里设置模型**：左栏底部的“模型”页可以选 DeepSeek、OpenAI、OpenRouter、本机 Ollama 或任何兼容 OpenAI 接口的服务。保存前先让模型回答一个测试问题，答不上来就不保存并说明原因。密钥存在图谱旁边的 `model.json`（Linux 和 macOS 上权限 `0600`），之后不再显示，换地址时不会沿用；只有本人能修改，Agent 不能。环境变量 `EPISTEME_MODEL_*` 仍然优先。
- **第一次打开有欢迎页**：还没有空间时，首页按顺序列出三步：选模型、建第一个空间（在这里直接建好并进入）、接入 Agent（可选）。
- **一键接入这台电脑上的 Agent**：“接入 Agent”页面自动找出装了哪些 Agent——Claude Code、Codex、Gemini CLI、Qwen Code、Kimi CLI、CodeBuddy、opencode、Trae（国际版和中国版）、Cursor、VS Code（Copilot）、Cline、Roo Code、Windsurf、Kiro、Zed、Claude Desktop——每个都标明已接入、未接入、地址已变或配置读不懂，点“接入”或“断开”即可。有命令的 Agent 用它自己的命令接入，其余改它的 MCP 配置文件：只动 `episteme` 这一项，保留注释和其他设置，第一次改前留一份 `.before-episteme` 备份；读不懂的文件不会被改。只能启动本地程序的客户端（Claude Desktop）通过工作台自带的中转程序接入。页面还显示每个 Agent 最后一次调用的时间和次数，以及没用这里的地址、自己连上来的其他客户端。自己写的 Agent 可以填配置文件路径、键名和格式加进列表，下面还保留手动接入用的地址。
- **所有对话页**：左栏底部的“所有对话”列出各个空间里的对话，包括 Agent 通过 MCP 开的，显示参与者（你或哪个 Agent）、条数和最后时间；可以按名字、空间和参与者筛选，可以重命名、归档和移回。对话不能彻底删除，因为你确认过的理解把对话原话当作依据，记录只追加。
- **Agent 会话记录页**：只读地浏览和搜索这台电脑上 Agent 自己保存的会话——Claude Code、Codex、Gemini CLI、Qwen Code、Kimi CLI 和 opencode；可以按 Agent 分开看，搜索标题、项目和对话内容。这些内容只显示给你，不会发给任何 Agent 或模型，Agent 令牌也读不到。
- **发布流程**（`.github/workflows/release.yml`）：改动桌面程序的 PR 会在 Windows、macOS（Apple 芯片）和 Linux 上各构建一次安装包；推送 `v*` 标签时汇总安装包和 `SHA256SUMS`，建成草稿版本，要有人检查后手动发布。

### 不兼容的变化

- **存储只用 SQLite**（[ADR 0018](docs/decisions/0018-sqlite-only.md)）：一个图谱就是一个 SQLite 文件，旁边的建议、材料、对话和场景记录也存在这个文件里，不再有 `.jsonl` 文件和 `.lock` 文件。`@episteme/storage-local`（JSONL）已删除，`graph import` / `graph export` 一并删除；旧的 JSONL 图谱和第 1 版 SQLite 图谱不能再直接打开，服务会拒绝并且不改动文件；用 `pnpm serve graph convert <旧图谱> <新图谱>` 转换成一个新文件，旧文件只读。默认图谱改为 `~/.episteme/learn.db`。
- **需要 Node 22 或更高版本**：Node 20 已于 2026 年 4 月停止维护；SQLite 驱动升级到 `better-sqlite3` 13。

### 修复

- **对话轮次记录写入来源**（[ADR 0021](docs/decisions/0021-turn-source.md)）：每个轮次记下写入它的凭证类型（本人或 Agent），由服务根据凭证判断，请求内容无法声明。用 Agent 令牌通过 REST 写入时，`by` 现在记录 Agent，不再记成本人。旧轮次不补写。对话、待确认候选、已确认的理解及其经过、学习结果页都会显示“Agent 转述”或“来源未记录”；因此旧图谱里不少原来写着“你的原话”的条目，现在会写“来源未记录”。

- **导出文件只有所有者能读**：Linux 和 macOS 上权限为 `0600`；Windows 不支持这个设置，文件沿用所在目录的权限。导出和导入的提示也写明了：导出的是整个图谱，多人使用时包含其他人的内容；校验值无法证明内容是谁写的。

- **Agent 令牌不能再动场景里的高影响操作**（[ADR 0020](docs/decisions/0020-scene-route-capabilities.md)）：之前 Agent 令牌，以及本机上不带任何凭证的请求，都能删除材料、归档或改名学习空间。现在场景的写操作默认只有本人能做，Agent 只能使用明确开放的提议类操作（新建空间、添加材料、起草计划、生成待审候选）。依赖这些旧行为的脚本需要改用本人的令牌，托管的 Workspace 不受影响。

## [0.1.0] - 2026-10-09

**First Real Learning Loop**，第一个开发预览版（Developer Preview），不是面向普通用户的稳定版本。发布说明见 [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md)。

本版第一次把下面这个闭环完整实现，并用自动化测试证明：

```text
Agent A 提交带原文证据的候选理解
  → Episteme 校验引用并保存来源
  → 学习者审阅确认
  → 理解进入图谱
  → Agent B 通过 recall 取回已确认的理解
```

这个闭环尚未由真实的 Claude Code Host 和真实学习者走通过。

### 新增

- **认知图谱核心**（`@episteme/core`）：注册制词汇表、图谱、守卫（guard）、只追加的状态事件日志、分支（fork）、投影与检索。理解是多维状态，没有单一的掌握度分数。
- **持久化**（`@episteme/storage-local`）：图谱与事件历史写入本地 JSONL 文件，重启后完整恢复；同一图谱同时只能被一个进程打开。
- **检索**：词法、语义、图结构、认知状态与时间多信号混合排序，每条结果附带各信号的贡献；另有基于 HTTP 的 embedding 适配器（`@episteme/embeddings-http`）。
- **Learn 场景**（`@episteme/domain-learn`、`apps/learn`）：中英文学习界面，可以提问、查看检索依据、记录自己的理解，并查看"已经理解了什么"。
- **Agent 接入**（`@episteme/mcp`）：通过 MCP 提供 `recall`、`propose`、`reflect`、`distill` 四个工具，没有任何确认工具。
- **人工审阅**（`@episteme/application`）：所有建议先作为待审草稿保存，只有学习者接受、修改后才进入图谱；决策过程有预写记录，崩溃后可恢复，且不会重复生效。
- **蒸馏**（`@episteme/distillation`）：把学习材料或对话切分为学习片段，由规则型读取器提取候选的问题、论断、证据与术语，每条候选都附带原文出处。
- **Host 辅助蒸馏**（ADR 0011）：Host 的模型可以提交自己对材料的解读。Episteme 在规范化后的原文中逐字核对每一条引用，要求每条候选标明 `stated` 或 `inferred`，支持跨片段的修正关系（`revises`）。按 `submissionId` 重试是幂等的，草稿写入失败后可以恢复。
- **Episteme Service**（`apps/service`，ADR 0010）：唯一持有图谱的进程，在 `/mcp` 提供 MCP，在 `/api/v1` 提供带版本的 REST，并托管 Workspace 页面。
- **跨 Agent 验收测试**：两个 MCP 客户端共享一个 Service，证明一个 Agent 提出、学习者确认的理解，能被另一个 Agent 取回。

### 修复

- 决策过程在写入失败或进程中断后不会重复生效，也不会丢失（`fix(application): make decisions crash-consistent and idempotent`）。
- 同一会话中的修改按顺序执行，两个决定不会同时作用于同一条草稿。
- 带 `submissionId` 的提交只有在草稿真正入队后才算完成；草稿写入失败后重试会重新处理，而不是报告为已提交。
- Service 的 HTTP 边界拒绝来自其他网页的请求（Host、Origin、`Sec-Fetch-Site` 检查），Workspace 静态文件不会越出其目录。

### 已知限制

真实 Host 尚未验证；REST 审阅接口没有身份授权；Workspace 尚未显示 `basis` 与说话人；检索受确定性 embedding 限制；`not_pending` 不等于已驳回；数据以明文保存在本地。详见[发布说明](docs/releases/v0.1.0.md#已知限制与安全说明)。

[0.1.0]: https://github.com/SAIR-club/Episteme/releases/tag/v0.1.0
