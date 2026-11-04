# 复用决策记录 0004：G4 发布、引用、回应和谱系

调查日期：2026-11-02。许可证和活跃时间来自当日 GitHub API，实现证据来自当日读到的源文件。

## 目标能力

A 选择性发布已审阅的理解，发布前看清楚公开什么；B 浏览、搜索、引用，并提出有归属的修正、反驳或支持；系统能从 B 的版本追到 A 的原文，A 的内容不被覆盖；不要求所有人共享一个结论。

## 审计：本仓已有能力

G4 的核心机制已经在 ADR 0014 落地，工作台缺的是人能走完的路。

| 能力 | 已有实现 | G4 怎么用 |
| ---- | ---- | ---- |
| 发布记录 | `packages/core/src/publication`：成员、闭包校验、撤回、版本替换 | 原样使用。公开内容的边界不由工作台决定 |
| 预览 | `publicationPlan`：公开节点和私有计数 | 发布流程的第二步，确认前必须看到 |
| 浏览和版本 | `browsePublications`、`publicationView` | 列表、详情、版本切换 |
| 采纳 | `POST /publications/:id/adopt`，只接受人，状态必须自己填 | 引用。页面不预填确信程度 |
| 新版本提醒 | `updates` | 引用过的人能看新版本，或继续用引用的那版 |
| 身份和模式 | `shared` 模式、用户文件、人和代理令牌 | 登录页和 `add-person` 命令。代理令牌发布、撤回、采纳都被拒绝 |
| 候选和审阅 | `distill`、`propose`、`/suggestions/decide` | 回应走同一条路：先产生候选，再由人接受 |

**新增的只有这些：** `GET /me` 和 `Directory.nameOf`（只给自己和仍有在线发布的作者显示名字）、`SceneView.updates`、`forks_from` 边的约定、`apps/workbench/src/sharing.ts`、`apps/workbench/web/src/Commons.tsx`。Core 没有改动。

## 候选项目

| 项目 | 许可证 | 最近推送 | 和 G4 的关系 |
| ---- | ---- | ---- | ---- |
| [hypothesis/h](https://github.com/hypothesis/h) | BSD-2-Clause | 2026-11-01 | 对公开内容做批注和回复，有私有和分享的区别 |
| [fedwiki/wiki](https://github.com/fedwiki/wiki)（含 `wiki-client`、`wiki-server`） | GitHub 未识别出 SPDX 标识 | 2026-09-27 | 分叉别人的页面，靠 journal 保留来源 |
| [Nanopublication/nanopub-java](https://github.com/Nanopublication/nanopub-java) | MIT | 2026-11-02 | 带来源的最小可引用断言。只看了元数据，没读实现，不作为依据 |
| [wikimedia/mediawiki](https://github.com/wikimedia/mediawiki) | GitHub 未识别出 SPDX 标识 | 2026-11-02 | 共同编辑一页。模型相反：只有一个当前版本，所以排除 |

## 实现证据

- Hypothesis 的 `h/models/annotation.py`：回复用 `references` 数组串起从根到父的链，`shared` 区分私有和分享，删除是 `deleted` 标记，不是直接抹掉。
- Federated Wiki 的 `wiki-client/lib/actionSymbols.js` 和 `addToJournal.js`：页面带 journal，`fork` 是其中一种动作，和 `create`、`edit`、`add` 并列。来源跟着页面走，各站点保留各自的副本。

## 借鉴和不借鉴

| 做法 | 决定 | 原因 |
| ---- | ---- | ---- |
| Hypothesis：回复是独立对象，默认私有 | 借鉴 | 回应是 B 自己的节点，发布前只有 B 能看到。原文不变 |
| Hypothesis：`references` 存祖先链 | 不借鉴 | 我们已有图。边 `forks_from` 从 B 指向 A，谱系沿边走出来，不再存一份 |
| Federated Wiki：分叉后各持一份，来源可追 | 借鉴模型 | 不强迫共享唯一结论 |
| Federated Wiki：跨站点复制整页 | 不做 | PRD 不要求联邦。同一服务、同一张图就够，引用不复制内容 |
| 用 `evolves_to` 表示 B 的版本 | 不用 | 会让 A 的节点看起来被修正过。这是 G4 最重要的约束，所以另设 `forks_from`，只有 B 的视图把它当作自己的当前版本 |
| 把回应理由自动放进发布内容 | 不做 | 理由起初是私人记录。发布时预填到“说明”，本人看得到、改得了、删得掉，确认页再显示一次 |

## 复用选项

1. 接入 Hypothesis：它针对网页和 PDF 锚点，要 Elasticsearch、Postgres 和自己的账号体系，与单 SQLite 约束冲突。排除。
2. 接入 Federated Wiki：它的单位是页面和站点，不是可审阅的理解。排除。
3. 用本仓的发布机制，只加工作台的路由和页面。**采用。**

**没有新增依赖，也没有复制第三方代码。** 差异显示是按字符的最长公共子序列，几十行，理解标签有长度上限。

## 成本与风险

- 引用是私下的：作者看不到谁引用了自己，只看得到已发布的回应。这是有意的（ADR 0014），代价是作者不知道影响范围。
- 第一次发布会备份图谱文件，之后更早的构建打不开这张图。
- 回到本决策需要重新评估的情况：要跨服务分享，或者要在材料原文上做批注。

## 决策

用本仓的发布机制，加工作台的路由和页面。回应是独立的节点，用 `forks_from`、`contradicts`、`supports` 边指回原文。
