# 复用决策记录 0005：G5 导出恢复、非学习场景和宿主验证

调查日期：2026-11-02。许可证和活跃时间来自当日 GitHub API，实现证据来自当日读到的源文件。

## 目标能力

把一个图谱导出成可校验的文件，带来源和版本信息，能恢复到新环境，内容和历史不丢；非学习场景不改 Core；真实 MCP 宿主能走通。

## 本仓已有能力

| 能力 | 已有实现 | G5 怎么用 |
| ---- | ---- | ---- |
| 单文件存储和独占锁 | `SqliteStorageAdapter`、`GraphLockedError` | 导出前取同一把锁，正在使用的图被拒绝 |
| 备份 | `backUp(target)` | 留作同格式备份。它是 SQLite 文件副本，不是可校验的可移植格式 |
| 记录校验 | `deserializeRecord` | 导入时逐条校验 |
| 场景扩展 | `SessionScene`、`DomainPack`、`SceneProfile.routes` | 假设场景直接用，没有新增扩展点 |
| MCP 线上测试 | `tests/mcp-wire.ts` | 一致性测试复用 |

## 候选项目

| 项目 | 许可证 | 最近推送 | 和 G5 的关系 |
| ---- | ---- | ---- | ---- |
| [usememos/memos](https://github.com/usememos/memos) | MIT | 2026-11-02 | `core/memoexport`：有版本的导出格式，带 manifest 和 golden 测试 |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | Open WebUI License（BSD 式，附品牌条款） | 2026-11-02 | `routers/utils.py` 的 `/db/download`：直接下载原始 SQLite 文件 |
| [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) | MIT | 当日查看 | 2026-07-28 协议，已由 `@modelcontextprotocol/server` 实现 |

## 实现证据

**memos（commit `b40d8a7`）：** `format.go` 定义 `Format`、`FormatVersion`、`FormatMajor`、`Generator{Name,Version}`、`Counts`，注释说明 counts 用来发现截断。`reader.go` 先校验整个容器，遇到硬错误就失败，不返回部分结果；附件逐个校验 SHA-256。

**open-webui：** 管理员接口直接用 `FileResponse` 返回数据库文件。简单，但不带校验和版本，文件还可能被正在运行的进程写入。

## 复用选项和决定

| 选项 | 决定 | 理由 |
| ---- | ---- | ---- |
| 引入 memos 的代码 | 否 | Go 代码，而且它的结构是 memo，不是事件日志和伴生日志 |
| 借鉴 memos 的格式设计 | **是，只借鉴思路** | `format`、`version`、生成者、计数、先全部校验再写入。没有复制代码 |
| 只提供原始数据库下载（open-webui 的做法） | 否 | 无法发现损坏或编辑，新旧版本不兼容时也不报错 |
| 基于 JSON 的单文件，正文保持原样 | **是** | 伴生日志的正文不归存储包解析，原样保留才能保证“出去什么，回来什么”。不需要新依赖 |
| 导入时合并到已有图 | 否 | 这会重写已有历史，是不可逆操作。只导入到新文件 |
| 引入 zip 处理附件 | 否 | 材料都在 SQLite 的伴生日志里，没有独立附件 |

**新增依赖：无。** `pnpm-lock.yaml` 只多了工作区链接 `@episteme/hypothesis`。

## 成本和风险

- 整个图读进内存再写，图很大时占内存。目前规模下可以接受，超大图没有测过。
- 导出文件明文包含私人材料和对话，命令输出会提醒。没有加密。
- 版本不一致直接拒绝，没有写跨版本迁移。以后格式升级时需要补。
- 登录令牌不在图里，所以不在导出里；恢复共享工作台需要同一份用户文件。

## ADR 影响

没有新增 ADR。导出和导入不改变存储格式（`user_version` 仍是 2）。`RankedView.kept` 是读取视图的新增字段，不写入存储。
