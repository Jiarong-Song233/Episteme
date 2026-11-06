# Agent 插件

“接入 Agent”页认识的 Agent 是内置的一张表。表里没有的 Agent，可以写一个插件告诉 Episteme 怎么接入它。

插件是一个 JSON 文件。放法有两种：

- 在“接入 Agent”页的“用插件加入 Agent”里粘贴，然后点“加入插件”。
- 直接放进图谱旁边的 `agent-plugins` 文件夹，例如 `~/.episteme/agent-plugins/my-agent.json`。下次打开这个页面时就会列出来。

插件只描述 Agent，本身不做任何事。接入插件里的 Agent 和接入内置的 Agent 是一回事：

- 改它的 MCP 配置时，只改 `episteme` 这一项。
- 运行它自己的命令时，只带固定的词和工作台的地址。
- 放技能时，只放 `episteme` 这个技能。

接入的 Agent 和其他 Agent 一样，只能读和提出候选，确认只有你本人能做。

## 写法

```json
{
  "id": "my-agent",
  "name": "我的 Agent",
  "maker": "某公司",
  "kind": "desktop",
  "detect": ["~/.my-agent"],
  "settings": { "file": "~/.my-agent/mcp.json", "key": "mcpServers", "style": "type-http" },
  "after": "重启它后生效。"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 小写字母、数字和 `-`，不能和内置的 Agent 重名。也是它的接入地址里的 `client=`。 |
| `name` | 是 | 页面上显示的名字，最多 60 个字。 |
| `maker` | | 出品方。 |
| `kind` | | `cli`、`editor`、`desktop`、`extension` 或 `manager`，默认 `desktop`。 |
| `detect` | | 文件或文件夹，有一个存在就算装了。 |
| `commands` | | 它在 PATH 上的命令，有一个存在也算装了。第一个是 `cli` 用的命令。 |
| `settings` | 三选一 | 它的 MCP 配置文件（`.json` 或 `.jsonc`）、服务器列表的名字（`mcpServers`、`servers`、`mcp`、`context_servers`）和写法（见下）。 |
| `cli` | 三选一 | 它自己添加和删除服务器的命令：`add` 里要有一项是 `{url}`，接入时换成工作台的地址；`remove` 是删除用的命令；`list` 可选，是列出服务器用的命令，输出里有一行以 `episteme` 开头就算已接入。 |
| `skills` | 三选一 | 它的技能文件夹。接入时放一个 `episteme/SKILL.md`，教它用命令行调用工作台。 |
| `untagged` | | `true` 时给它不带 `client=` 的地址。适合替多个 Agent 写设置的管理程序：每个 Agent 会按自己报的名字区分。 |
| `after` | | 接入后显示的话，例如要不要重启。 |

`settings`、`cli` 和 `skills` 至少写一个。都写了的话，有命令时先用命令，失败了改配置文件。

路径可以用 `~`、`{home}`、`{appData}`（Windows 的 `%APPDATA%`）和 `{localAppData}`（Windows 的 `%LOCALAPPDATA%`）开头，也可以写完整路径。

命令和它的每个词只能有字母、数字和 `. _ - : / = @ , + { }`。所以插件不能借命令做别的事。

### 写法（`style`）

| `style` | 写进去的样子 |
| --- | --- |
| `url` | `{ "url": 地址 }` |
| `type-http` | `{ "type": "http", "url": 地址 }` |
| `httpUrl` | `{ "httpUrl": 地址 }` |
| `serverUrl` | `{ "serverUrl": 地址 }` |
| `streamableHttp` | `{ "type": "streamableHttp", "url": 地址, "disabled": false }` |
| `streamable-http` | `{ "type": "streamable-http", "url": 地址 }` |
| `opencode` | `{ "type": "remote", "url": 地址, "enabled": true }` |
| `stdio` | `{ "command": node, "args": [中转程序, 地址] }`，给只能启动本地程序的客户端 |

## 例子：只认命令的 Agent

```json
{
  "id": "tool-agent",
  "name": "Tool",
  "kind": "cli",
  "commands": ["tool"],
  "cli": {
    "add": ["mcp", "add", "episteme", "{url}"],
    "remove": ["mcp", "remove", "episteme"],
    "list": ["mcp", "list"]
  }
}
```

## 例子：只读技能的 Agent

```json
{
  "id": "skill-agent",
  "name": "只读技能的 Agent",
  "skills": "{localAppData}/SkillAgent/skills"
}
```

它会得到一个技能，技能里写着用 `episteme-cli` 调用工作台的命令：

```
node episteme-cli.js --url http://127.0.0.1:4322/mcp?client=skill-agent tools
node episteme-cli.js --url http://127.0.0.1:4322/mcp?client=skill-agent call recall "{\"question\": \"…\"}"
```

`episteme-cli` 只连这台电脑上的工作台。工作台没开时，它会说连不上。

## 读不了的插件

一个插件文件读不了时，页面会列出这个文件和原因，其他插件照常加载。去掉插件只删它的文件，不改 Agent 的设置。要改 Agent 的设置，先在页面上断开。
