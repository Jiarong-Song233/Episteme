# 安装 Episteme 桌面程序

桌面程序自带运行环境和学习工作台，不需要另外装 Node 或 pnpm。打开后它在本机 `127.0.0.1:4322` 启动服务，关掉窗口时留在托盘（菜单栏）里，Agent 仍然连得上；从托盘选“退出 Episteme”才会停下服务。

> 目前只有 Windows x64、macOS（Apple 芯片）、Linux x64 的安装包。安装包还没有代码签名：Windows 可能提示“未知发布者”，macOS 从浏览器下载时可能需要在“系统设置 → 隐私与安全性”里放行（用下面的脚本安装不会遇到）。

## 一行命令安装

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/Jiarong-Song233/Episteme/main/scripts/install.ps1 | iex
```

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Jiarong-Song233/Episteme/main/scripts/install.sh | sh
```

脚本做的事情：

1. 从 GitHub 上最新发布的版本下载安装包和 `SHA256SUMS`；
2. 校验值不符就停下，不安装；
3. 只为当前用户安装，不需要管理员权限：Windows 静默运行安装程序，macOS 放进 `~/Applications`，Linux 把 AppImage 放到 `~/.local/bin/episteme` 并加一个桌面快捷方式；
4. 打开程序。

脚本默认不碰 Agent 的配置。想顺便接入 Agent，运行前设置 `EPISTEME_CONNECT`：

```powershell
$env:EPISTEME_CONNECT = 'claude,codex'; irm https://raw.githubusercontent.com/Jiarong-Song233/Episteme/main/scripts/install.ps1 | iex
```

```sh
curl -fsSL https://raw.githubusercontent.com/Jiarong-Song233/Episteme/main/scripts/install.sh | EPISTEME_CONNECT=claude,codex sh
```

`EPISTEME_VERSION=v0.2.0` 可以装指定版本。

## 在程序里接入其他 Agent

打开 Episteme，点左栏底部的“接入 Agent”。页面会列出这台电脑上找到的 Agent，点“接入”即可，不用自己改配置。支持这些 Agent：

- 命令行：Claude Code、Codex、Gemini CLI、Antigravity CLI（agy）、Qwen Code、Kimi CLI、CodeBuddy、opencode。
- 编辑器和扩展：Antigravity、Trae、Trae CN、Qoder、Qoder CN、Cursor、VS Code、Cline、Roo Code、Windsurf、Kiro、Zed。
- 桌面程序：Claude Desktop、WorkBuddy、豆包工作。
- 管理程序：通过 magpie 接入 Pi、Hermes、OpenClaw、ZCode 和 DeepSeek Harness。

豆包工作不读 MCP 配置，接入时给它放一个 `episteme` 技能，让它用命令行调用工作台。

不在列表里的 Agent 有三种接法：

- 在“添加自定义 Agent”里填它的 MCP 配置文件。
- 写一个插件，见 [Agent 插件](agent-plugins.md)。
- 用页面下方的地址手动接入。

接入时只加一项 `episteme`，Agent 的其他设置不动；改文件前会留一份 `<原文件名>.before-episteme` 备份。点“断开”只去掉这一项。

## 让 Agent 帮你安装

把这句话发给 Claude Code、Codex 或其他能运行命令的 Agent：

> 按照 https://github.com/Jiarong-Song233/Episteme/blob/main/docs/install.md 帮我安装 Episteme，并把它接入你自己。

### 给 Agent 的步骤

如果你是被要求安装 Episteme 的 Agent，按下面做，不要跳过校验：

1. 判断系统。Windows 运行 PowerShell 那一行；macOS 和 Linux 运行 `curl … | sh` 那一行。运行前先告诉用户你要执行的命令。
2. 脚本输出 `installed` 和 `started Episteme` 就是成功。出现 `checksum mismatch` 时停下并告诉用户，不要换一种方式绕过。出现 `no published release` 说明还没有发布版本，告诉用户即可。
3. 把自己接入 Episteme（地址固定是 `http://127.0.0.1:4322/mcp`，只在本机可用）：
   - Claude Code：`claude mcp add --transport http --scope user episteme http://127.0.0.1:4322/mcp`
   - Codex：`codex mcp add episteme --url http://127.0.0.1:4322/mcp`。非交互的 `codex exec` 不会弹审批，提出候选（`propose`）会直接失败；需要时在那次运行加 `-c 'mcp_servers.episteme.default_tools_approval_mode="approve"'`。这只放开 Codex 这边的审批，候选仍然要用户本人确认。
   - 其他客户端：在它的 MCP 配置里加 `{"mcpServers":{"episteme":{"type":"http","url":"http://127.0.0.1:4322/mcp"}}}`
4. 提醒用户：接入后你只能读取用户确认过的理解、提出候选理解；候选要用户本人在工作台的“待确认”里确认才算数。你不能替用户确认。
5. 告诉用户在工作台左栏底部的“模型”页里填模型和密钥。不要向用户索要密钥，也不要替用户填写。

## 设置模型

第一次打开时，工作台用的是模拟模型：它只摘录材料原句，不会真正回答。点左栏底部的“模型”（或欢迎页上的“设置模型”），选一个常用服务或填任何兼容 OpenAI 接口的地址，再填模型名和密钥，点“测试并保存”。工作台会先用它回答一个测试问题，答上来才保存；地址、模型名或密钥不对时会说明原因，原来的设置不变。

- 密钥只保存在本机图谱旁边的 `model.json` 里（Linux 和 macOS 上只有你能读），保存后不会再显示在页面上，也不会交给 Agent。只有你本人能修改这里，Agent 改不了。
- 换地址时要重新填密钥，原来的密钥不会发给新地址。
- “改回模拟模型”会删除 `model.json`。
- 每次启动后最多调用 100 次、20 万 token，超出后回答会失败，重启程序即可重置。
- 如果启动时设置了环境变量 `EPISTEME_MODEL_BASE_URL` 和 `EPISTEME_MODEL_NAME`，以环境变量为准，页面上只显示、不能修改。
- 多人使用（`--shared`）时，所有人共用一个模型，页面上不能设置，任何登录的人和 Agent 都不能修改或清除。由运行服务的人在启动前用上面的环境变量配置，或者在图谱旁边放好 `model.json`。页面上只显示模型名。

## 语义检索（可选）

默认只按关键词召回。想让换个说法的问题也能找到你的理解，可以在启动服务前设置一个嵌入（embedding）服务：

| 环境变量 | 说明 |
| --- | --- |
| `EPISTEME_EMBEDDINGS_URL` | 服务的根地址，不带路径：例如 `http://127.0.0.1:11434`（Ollama）。`openai` 协议会请求 `<地址>/v1/embeddings`，所以不要在末尾写 `/v1` |
| `EPISTEME_EMBEDDINGS_MODEL` | 嵌入模型名 |
| `EPISTEME_EMBEDDINGS_PROTOCOL` | `openai`（默认）、`ollama` 或 `tei` |
| `EPISTEME_EMBEDDINGS_API_KEY` | 需要时填，不会显示也不会交给 Agent |
| `EPISTEME_EMBEDDINGS_TIMEOUT_MS` | 超时，默认 10000 |

地址和模型名要一起设置，只设一个时服务拒绝启动并说明原因。启动时会显示正在用哪个模型。嵌入服务出错时，那一次召回退回关键词检索，并在回答里说明。向量只缓存在内存里，不写进图谱。这一项还没有用真实的嵌入模型验证过。

## 卸载

- Windows：在“设置 → 应用”里卸载 Episteme。
- macOS：删除 `~/Applications/Episteme.app`。
- Linux：删除 `~/.local/bin/episteme` 和 `~/.local/share/applications/episteme.desktop`。

卸载不会删除你的学习数据。数据在 `~/.episteme/` 下，需要时自己备份或删除。
