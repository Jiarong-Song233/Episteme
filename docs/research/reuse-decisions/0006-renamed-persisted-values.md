# 复用决策记录 0006：已持久化的值改名

调查日期：2026-11-13。外部做法来自当日读到的官方规范页面。

## 目标能力

把决定通道 `learn-review` 改成 `review`，事件来源 `learn-surface` 改成 `session`，和团队仓 SAIR #86 一致。已有图谱里的旧值不能消失在筛选里，也不能被改写（不做数据迁移）。

## 本仓和团队仓已有能力

| 来源 | 已有实现 | 用法 |
| ---- | ---- | ---- |
| SAIR #86（已合并） | 新写入改名为 `review`、`session` | **直接对齐它的名字**，不另起名 |
| SAIR #86 | 没有读兼容：`?channel=review` 漏掉旧记录 | 不照搬这一点 |
| 本仓 `tests/older-graph/` | 旧版本写出的图谱夹具，含两条 `learn-review` 审阅 | 用作兼容测试的输入，不重新生成 |
| 本仓 `convertGraph` | 原样搬运旧记录 | 不改，改名不经过转换 |

## 外部做法

| 项目 | 许可证 | 做法 |
| ---- | ---- | ---- |
| [Apache Avro 规范](https://avro.apache.org/docs/1.11.1/specification/) | Apache-2.0 | 读方 schema 带 `aliases`，读取时把写方的旧名当作新名；数据不改写。枚举遇到读方不认识的符号时用 `default` |
| [Protocol Buffers proto3 指南](https://protobuf.dev/programming-guides/proto3/) | 文档 CC-BY 4.0 | 删掉的名字用 `reserved` 保留，防止以后被别的意思复用；枚举别名需 `allow_alias`，反序列化只取第一个名字 |

## 决策

| 项 | 内容 |
| ---- | ---- |
| 复用选项 | 参考后重写：采用 Avro 的“读方别名”做法，名字取自 SAIR #86 |
| 不引入依赖 | 只是一张旧名到新名的表（`currentChannel`），引入 Avro 或 protobuf 的库没有必要 |
| 读 | `reviews()` 返回新名；`?channel=` 的参数也先换算，新旧名查到同样的结果 |
| 写 | 只写新名；SDK 传旧名时按新名写 |
| 保留 | 旧名不复用，作用同 protobuf 的 `reserved`：`learn-review` 永远指 `review` |
| 事件来源 | `source` 是来源说明，不做筛选，旧事件原样显示 |

## 成本和风险

- 成本：一张映射表、两处读取、一个兼容测试。
- 风险：仓外脚本若按字符串精确等于 `learn-review` 去读 API，会看到 `review`。仓内没有这样的读取方。
- 验证：`tests/channel-names.test.ts`；本机真实图谱的副本上读出 3 条旧审阅，文件哈希不变。

PR：[#53](https://github.com/Jiarong-Song233/Episteme/pull/53)。
