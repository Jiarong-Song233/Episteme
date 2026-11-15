import { useEffect, useState, type FormEvent } from 'react'
import {
  api,
  type AgentInfo,
  type AgentSessionInfo,
  type AgentUse,
  type BlockInfo,
  type ConversationInfo,
  type Dimension,
  type HeldNode,
  type MaterialSummary,
  type Me,
  type ModelInfo,
  type PendingCandidate,
  type Plan,
  type PublicationSummary,
  type Space,
  type Status,
  type Step,
  type TrailEntry,
  type Understanding,
  type WorkflowInfo,
} from './api.js'
import { visionHref, type VisionKind, type VisionPlace } from './routes.js'
import { wordsOf } from './Understanding.js'

/** The published workbench: one first-level navigation over the service's existing graph and REST paths. */

type Run = (work: () => Promise<unknown>) => void

interface Reading {
  readonly space: Space
  readonly materials: readonly MaterialSummary[]
  readonly understanding: Understanding
  readonly plans: readonly Plan[]
  readonly status: Status
}

interface VisionData {
  readonly readings: readonly Reading[]
  readonly publications: readonly PublicationSummary[]
}

interface VisionDeskProps {
  readonly me: Me
  readonly place: VisionPlace
  readonly spaces: readonly Space[]
  readonly listed: boolean
  readonly spaceId: string | undefined
  readonly workflows: readonly WorkflowInfo[]
  readonly blocks: readonly BlockInfo[]
  readonly model: ModelInfo | undefined
  readonly notice: string | undefined
  readonly guard: (work: () => Promise<unknown>) => void
  readonly onChanged: () => Promise<void>
  readonly onSpaces: (spaces: readonly Space[]) => void
}

const NAV: readonly {
  readonly kind: VisionKind
  readonly label: string
  readonly glyph: string
}[] = [
  { kind: 'desk', label: '工作台', glyph: '⌂' },
  { kind: 'learning-spaces', label: '学习空间', glyph: '▤' },
  { kind: 'network', label: '知识网络', glyph: '⌘' },
  { kind: 'review-center', label: '审阅中心', glyph: '✓' },
  { kind: 'learning-flow', label: '学习流程', glyph: '◇' },
  { kind: 'shared-outcomes', label: '共享成果', glyph: '⧉' },
  { kind: 'my-materials', label: '我的资料', glyph: '▣' },
  { kind: 'client', label: '客户端', glyph: '◈' },
]

const NETWORK_TABS = [
  { id: 'concepts', label: '概念' },
  { id: 'relations', label: '关系' },
  { id: 'timeline', label: '时间线' },
  { id: 'sources', label: '来源' },
] as const

type NetworkTab = (typeof NETWORK_TABS)[number]['id']

const held = (node: HeldNode): boolean => node.revisedTo === undefined && !node.withdrawn

const matches = (query: string, ...parts: readonly (string | undefined)[]): boolean => {
  const wanted = query.trim()
  return wanted === '' || parts.some((part) => part?.includes(wanted) === true)
}

const candidateLabel = (candidate: PendingCandidate): string => {
  if (candidate.link !== undefined) {
    return `${candidate.link.fromLabel} → ${candidate.link.toLabel}`
  }
  return candidate.proposal.label ?? candidate.rationale
}

const dayOf = (at: number | string | undefined): string => {
  if (at === undefined || at === '') return '时间未记录'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return String(at)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const shortDay = (at: number): string =>
  new Date(at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })

const materialWords = (material: MaterialSummary): string =>
  `${material.title}，${material.characters} 字，${material.chunks} 段`

const legacySpaceHref = (space: string): string => `#/spaces/${encodeURIComponent(space)}`

function trailWords(entry: TrailEntry, dimensions: readonly Dimension[]): string {
  switch (entry.kind) {
    case 'proposed':
      return '这条理解由你确认进入网络。'
    case 'revised_from':
      return `由“${entry.label}”修正而来。${entry.reason ?? ''}`
    case 'revised_to':
      return `修正为“${entry.label}”。${entry.reason ?? ''}`
    case 'state': {
      const dimension = dimensions.find((candidate) => candidate.id === entry.dimension)
      const level = dimension?.levelLabelsZh.find((one) => one.level === entry.level)?.label
      return `${dimension?.labelZh ?? entry.dimension}：${level ?? entry.level}。${entry.reason ?? ''}`
    }
    case 'challenged':
      return `质疑：${entry.challenge.text}`
    case 'adopted':
      return `引用了 ${entry.author} 发布的成果。`
    case 'forked_from':
      return `这是对“${entry.label}”提出的版本。${entry.reason ?? ''}`
    case 'forked_to':
      return `由此分叉出“${entry.label}”。${entry.reason ?? ''}`
  }
}

function VisionNav(props: {
  readonly kind: VisionKind
  readonly spaceId: string | undefined
  readonly currentName: string | undefined
  readonly pending: number
}) {
  return (
    <aside className="vision-nav" aria-label="一级导航">
      <a className="vision-wordmark" href={visionHref('desk', props.spaceId)}>
        <span className="vision-logo" aria-hidden="true">
          ✦
        </span>
        <span>Episteme</span>
      </a>
      <nav aria-label="页面">
        <ul>
          {NAV.map((item) => (
            <li key={item.kind}>
              <a
                href={visionHref(item.kind, props.spaceId)}
                aria-label={item.label}
                aria-current={props.kind === item.kind ? 'page' : undefined}
                className="vision-nav-link"
              >
                <span className="vision-glyph" aria-hidden="true">
                  {item.glyph}
                </span>
                <span>{item.label}</span>
                {item.kind === 'review-center' && props.pending > 0 && (
                  <span className="vision-nav-count" aria-hidden="true">
                    {props.pending}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <footer className="vision-nav-foot">
        <span className="hint">当前空间</span>
        <strong>{props.currentName ?? '还没有空间'}</strong>
      </footer>
    </aside>
  )
}

function VisionHeader(props: {
  readonly title: string
  readonly subtitle: string
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly name: string
}) {
  return (
    <header className="vision-header">
      <div className="vision-heading">
        <h1>{props.title}</h1>
        <p>{props.subtitle}</p>
      </div>
      <label className="vision-search">
        <span aria-hidden="true">⌕</span>
        <input
          aria-label="搜索知识、资料或提问…"
          placeholder="搜索知识、资料或提问…"
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
        />
      </label>
      <div className="vision-avatar" aria-label={`当前用户 ${props.name}`}>
        {props.name.slice(0, 1)}
      </div>
    </header>
  )
}

export function VisionDesk(props: VisionDeskProps) {
  const [data, setData] = useState<VisionData>()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!props.listed) return undefined
    let current = true
    props.guard(async () => {
      const readings = await Promise.all(
        props.spaces.map(async (space): Promise<Reading> => {
          const [materials, understanding, plans, status] = await Promise.all([
            api.materials(space.id),
            api.understanding(space.id),
            api.plans(space.id),
            api.status(space.id),
          ])
          return {
            space,
            materials: materials.materials,
            understanding,
            plans: plans.plans,
            status,
          }
        }),
      )
      const publications = (await api.publications('', undefined)).publications
      if (current) setData({ readings, publications })
    })
    return () => {
      current = false
    }
  }, [props.listed, props.spaces, props.guard, version])

  const run: Run = (work) => {
    setBusy(true)
    props.guard(async () => {
      try {
        await work()
        await props.onChanged()
        setVersion((count) => count + 1)
      } finally {
        setBusy(false)
      }
    })
  }

  const readings = data?.readings ?? []
  const current =
    readings.find((reading) => reading.space.id === props.spaceId) ?? readings[0] ?? undefined
  const currentSpaceId = current?.space.id ?? props.spaceId
  const pending = readings.reduce(
    (count, reading) => count + reading.understanding.pending.length,
    0,
  )
  const meName = props.me.names[props.me.actorId] ?? '你'
  const planId = props.place.kind === 'learning-flow' ? props.place.plan : undefined
  const plan = current?.plans.find((candidate) => candidate.id === planId)
  const title =
    props.place.kind === 'desk'
      ? `欢迎回来，${meName}`
      : props.place.kind === 'network'
        ? `${current?.space.name ?? '理解网络'} · 理解网络`
        : props.place.kind === 'learning-flow'
          ? (plan?.topic ?? '学习流程')
          : (NAV.find((item) => item.kind === props.place.kind)?.label ?? '工作台')
  const subtitle =
    props.place.kind === 'desk'
      ? current === undefined
        ? '从第一个空间开始，把材料、理解与学习流程连在一起。'
        : `继续“${current.space.name}”里的理解构建与知识复用。`
      : props.place.kind === 'review-center'
        ? '审核 AI 提取的候选理解，决定是否纳入你的知识网络。'
        : props.place.kind === 'network'
          ? '浏览、编辑与复用理解结构，沉淀并持续完善你的认知网络。'
          : props.place.kind === 'client'
            ? '接入本机 Agent，导入对话历史，查看统一全局记忆与原有能力。'
            : props.place.kind === 'learning-flow'
              ? '按步骤回答、串联概念，并把自己的理解写成可复用节点。'
              : '这些页面直接读取当前图谱中的真实状态。'

  const page =
    data === undefined ? (
      <section className="vision-card vision-loading" role="status">
        正在读取真实图谱状态…
      </section>
    ) : (
      <>
        {props.place.kind === 'desk' && (
          <Dashboard
            data={data}
            current={current}
            query={query}
            model={props.model}
            busy={busy}
            run={run}
          />
        )}
        {props.place.kind === 'learning-spaces' && (
          <LearningSpacesPage
            data={data}
            query={query}
            busy={busy}
            run={run}
            onSpaces={props.onSpaces}
          />
        )}
        {props.place.kind === 'network' && (
          <NetworkPage
            current={current}
            selectedNode={props.place.node}
            query={query}
            guard={props.guard}
          />
        )}
        {props.place.kind === 'review-center' && (
          <ReviewCenterPage data={data} query={query} busy={busy} run={run} />
        )}
        {props.place.kind === 'learning-flow' && (
          <LearningFlowPage
            current={current}
            planId={planId}
            blocks={props.blocks}
            workflows={props.workflows}
            query={query}
            busy={busy}
            run={run}
          />
        )}
        {props.place.kind === 'shared-outcomes' && (
          <SharedOutcomesPage data={data} me={props.me} query={query} />
        )}
        {props.place.kind === 'my-materials' && <MyMaterialsPage data={data} query={query} />}
        {props.place.kind === 'client' && (
          <ClientPage
            me={props.me}
            data={data}
            spaces={props.spaces}
            current={current}
            guard={props.guard}
            busy={busy}
            run={run}
            reloadKey={version}
          />
        )}
      </>
    )

  return (
    <div className="vision-shell" data-page={props.place.kind}>
      <VisionNav
        kind={props.place.kind}
        spaceId={currentSpaceId}
        currentName={current?.space.name}
        pending={pending}
      />
      <main className="vision-main" id="vision-main">
        <VisionHeader
          title={title}
          subtitle={subtitle}
          query={query}
          onQuery={setQuery}
          name={meName}
        />
        {props.notice !== undefined && (
          <p className="vision-banner" role="alert">
            {props.notice}
          </p>
        )}
        <div className="vision-page">{page}</div>
      </main>
    </div>
  )
}

function Stat(props: { readonly label: string; readonly value: string; readonly name: string }) {
  return (
    <div className="vision-stat">
      <span>{props.label}</span>
      <strong data-stat={props.name}>{props.value}</strong>
    </div>
  )
}

function Dashboard(props: {
  readonly data: VisionData
  readonly current: Reading | undefined
  readonly query: string
  readonly model: ModelInfo | undefined
  readonly busy: boolean
  readonly run: Run
}) {
  const { data, current } = props
  const allNodes = data.readings.flatMap((reading) =>
    reading.understanding.nodes.filter(held).map((node) => ({ reading, node })),
  )
  const pending = data.readings.flatMap((reading) =>
    reading.understanding.pending.map((candidate) => ({ reading, candidate })),
  )
  const minutes = data.readings.reduce(
    (count, reading) =>
      count +
      reading.plans.reduce(
        (sum, plan) =>
          sum +
          plan.steps
            .filter((step) => step.status === 'done')
            .reduce((stepSum, step) => stepSum + step.minutes, 0),
        0,
      ),
    0,
  )
  const stats = {
    materials: data.readings.reduce((count, reading) => count + reading.materials.length, 0),
    pending: pending.length,
    minutes,
    nodes: allNodes.length,
  }
  const networkNodes = (
    current?.understanding.nodes.filter(held) ?? allNodes.map((one) => one.node)
  )
    .filter((node) => matches(props.query, node.label))
    .slice(0, 8)
  const activePlan =
    current?.plans.find((plan) => plan.status === 'active') ?? current?.plans[0] ?? undefined
  const recommendations = [
    pending.length > 0
      ? {
          label: `审阅 ${pending.length} 条候选理解`,
          detail: '候选仍需要你确认，确认后才会成为理解。',
          href: visionHref('review-center', current?.space.id),
        }
      : undefined,
    activePlan === undefined
      ? undefined
      : {
          label: `继续“${activePlan.topic}”`,
          detail: `计划还有 ${activePlan.steps.filter((step) => step.status !== 'done').length} 步未完成。`,
          href: visionHref('learning-flow', current?.space.id, activePlan.id),
        },
    current?.materials.length === 0
      ? {
          label: '为当前空间补充资料',
          detail: '回答与引用都从空间中的材料出发。',
          href:
            current === undefined
              ? visionHref('learning-spaces')
              : legacySpaceHref(current.space.id) + '/materials',
        }
      : undefined,
    allNodes.length > 0
      ? {
          label: '梳理当前的知识网络',
          detail: '按概念、关系、时间线与来源查看已确认的理解。',
          href: visionHref('network', current?.space.id),
        }
      : undefined,
  ].filter((item): item is { label: string; detail: string; href: string } => item !== undefined)
  const shownRecommendations = recommendations.filter((item) =>
    matches(props.query, item.label, item.detail),
  )
  const shared = data.publications.map((publication) => ({
    id: publication.id,
    label: publication.rootLabel,
    detail: `${publication.members} 个节点 · 第 ${publication.version} 版`,
    href: `#/commons/${encodeURIComponent(publication.id)}`,
  }))
  const reusable = allNodes.map(({ reading, node }) => ({
    id: node.nodeId,
    label: node.label,
    detail: `来自 ${reading.space.name}`,
    href: visionHref('network', reading.space.id, node.nodeId),
  }))
  const sharedItems = (shared.length > 0 ? shared : reusable).filter((item) =>
    matches(props.query, item.label, item.detail),
  )
  const modelName =
    props.model?.simulated === false ? (props.model.name ?? '已设置模型') : '模拟模型'

  return (
    <div className="dashboard-grid">
      <div className="vision-column">
        <section className="vision-card vision-stats" aria-labelledby="today-heading">
          <h2 id="today-heading">今日概览</h2>
          <div className="vision-stat-row">
            <Stat label="已整理资料数" value={String(stats.materials)} name="materials" />
            <Stat label="待审阅候选" value={String(stats.pending)} name="pending" />
            <Stat label="本周学习时长" value={`${stats.minutes} 分钟`} name="minutes" />
            <Stat label="可复用认知节点" value={String(stats.nodes)} name="nodes" />
          </div>
        </section>

        <section className="vision-card vision-current-space">
          <div>
            <h2>当前空间</h2>
            <h3>{current?.space.name ?? '还没有空间'}</h3>
            <p>
              {current === undefined
                ? '建一个空间后，这里会显示它的材料、候选、理解与计划。'
                : `${current.materials.length} 份资料，${current.understanding.nodes.filter(held).length} 条已确认理解，${current.understanding.pending.length} 条候选等待确认。`}
            </p>
          </div>
          <a
            className="vision-round-link"
            href={
              current === undefined
                ? visionHref('learning-spaces')
                : legacySpaceHref(current.space.id)
            }
            aria-label="打开当前空间"
          >
            →
          </a>
        </section>

        <div className="vision-split">
          <section className="vision-card vision-network-preview">
            <div className="vision-card-head">
              <h2>理解网络预览</h2>
              <a href={visionHref('network', current?.space.id)}>查看完整网络 →</a>
            </div>
            <div className="vision-mini-map" data-node-count={networkNodes.length}>
              {networkNodes.length === 0 ? (
                <p className="hint">确认候选理解后，节点会出现在这里。</p>
              ) : (
                networkNodes.map((node, index) => (
                  <a
                    key={node.nodeId}
                    href={visionHref('network', current?.space.id, node.nodeId)}
                    className="vision-node-pill"
                    data-position={index % 4}
                  >
                    {node.label}
                  </a>
                ))
              )}
            </div>
          </section>

          <section className="vision-card">
            <h2>推荐下一步</h2>
            <ul className="vision-actions">
              {shownRecommendations.length === 0 ? (
                <li className="hint">当前没有待办。可以从空间里开始一次提问。</li>
              ) : (
                shownRecommendations.map((item) => (
                  <li key={item.label}>
                    <a href={item.href}>
                      <strong>{item.label}</strong>
                      <span>{item.detail}</span>
                    </a>
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>

        <section className="vision-card">
          <div className="vision-card-head">
            <h2>共享与复用</h2>
            <a href={visionHref('shared-outcomes', current?.space.id)}>发现更多 →</a>
          </div>
          <div className="vision-shared-list">
            {sharedItems.length === 0 ? (
              <p className="hint">已确认的理解会成为这个空间里可复用的节点。</p>
            ) : (
              sharedItems.slice(0, 4).map((item) => (
                <a key={item.id} href={item.href} className="vision-shared-item">
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </a>
              ))
            )}
          </div>
        </section>
      </div>

      <aside className="vision-column vision-assistant-column">
        <section className="vision-card vision-assistant">
          <h2>AI 学习助手</h2>
          <div className="assistant-orb" aria-hidden="true">
            ✦
          </div>
          <p>
            你已确认 {stats.nodes} 条理解，还有 {stats.pending} 条候选等待判断。当前使用的是
            {modelName}。
          </p>
          <p className="hint">候选由 AI 提出，只有你接受或修改后才会进入理解网络。</p>
          <h3>你可以试试：</h3>
          <ul className="vision-actions">
            <li>
              <a href={visionHref('learning-flow', current?.space.id)}>为我生成学习计划</a>
            </li>
            <li>
              <a
                href={
                  current === undefined
                    ? visionHref('learning-spaces')
                    : `${legacySpaceHref(current.space.id)}/new`
                }
              >
                针对某个概念进行引导提问
              </a>
            </li>
            <li>
              <a href={visionHref('network', current?.space.id)}>帮我梳理当前的知识网络</a>
            </li>
            <li>
              <a href={visionHref('learning-flow', current?.space.id)}>设计一个定制学习流程</a>
            </li>
          </ul>
          <form
            className="vision-ask"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              if (current === undefined) window.location.hash = visionHref('learning-spaces')
              else window.location.hash = `${legacySpaceHref(current.space.id)}/new`
            }}
          >
            <input aria-label="向 AI 学习助手提问" placeholder="向我提问或表达你的学习目标…" />
            <button type="submit" className="vision-button" disabled={props.busy}>
              →
            </button>
          </form>
        </section>
      </aside>
    </div>
  )
}

function LearningSpacesPage(props: {
  readonly data: VisionData
  readonly query: string
  readonly busy: boolean
  readonly run: Run
  readonly onSpaces: (spaces: readonly Space[]) => void
}) {
  const [name, setName] = useState('')
  const shown = props.data.readings.filter((reading) => matches(props.query, reading.space.name))
  return (
    <div className="vision-two-column">
      <section className="vision-card">
        <h2>学习空间</h2>
        <p className="hint">每个空间有自己的材料、对话、候选理解与知识网络。</p>
        <ul className="vision-space-list">
          {shown.length === 0 ? (
            <li className="hint">还没有匹配的空间。</li>
          ) : (
            shown.map((reading) => (
              <li key={reading.space.id}>
                <div>
                  <strong>{reading.space.name}</strong>
                  <span>
                    {reading.materials.length} 份资料 ·{' '}
                    {reading.understanding.nodes.filter(held).length} 条理解 ·{' '}
                    {reading.plans.length} 个计划
                  </span>
                </div>
                <a className="vision-button secondary" href={legacySpaceHref(reading.space.id)}>
                  打开空间
                </a>
              </li>
            ))
          )}
        </ul>
      </section>
      <aside className="vision-card">
        <h2>新建空间</h2>
        <form
          className="vision-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            const wanted = name.trim()
            if (wanted === '') return
            props.run(async () => {
              const { space } = await api.createSpace(wanted)
              props.onSpaces((await api.spaces()).spaces)
              setName('')
              window.location.hash = visionHref('desk', space.id)
            })
          }}
        >
          <label>
            空间名称
            <input
              aria-label="新空间的名字"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：机器学习基础"
            />
          </label>
          <button
            className="vision-button"
            type="submit"
            disabled={props.busy || name.trim() === ''}
          >
            新建
          </button>
        </form>
        <p className="hint">新空间只写入当前图谱，旧链接与已有空间保持不变。</p>
      </aside>
    </div>
  )
}

function NetworkGraph(props: {
  readonly nodes: readonly HeldNode[]
  readonly onSelect: (node: string) => void
}) {
  const nodes = props.nodes
  if (nodes.length === 0) return null
  const width = 620
  const height = 310
  const radius = nodes.length === 1 ? 0 : Math.min(118, 48 + nodes.length * 9)
  const points = new Map(
    nodes.map((node, index) => {
      const angle = (Math.PI * 2 * index) / nodes.length - Math.PI / 2
      return [
        node.nodeId,
        {
          x: nodes.length === 1 ? width / 2 : width / 2 + radius * Math.cos(angle),
          y: nodes.length === 1 ? height / 2 : height / 2 + radius * Math.sin(angle),
        },
      ] as const
    }),
  )
  const edges = nodes.flatMap((node) =>
    node.relations
      .filter((relation) => relation.direction === 'out' && points.has(relation.nodeId))
      .map((relation) => ({ from: node.nodeId, to: relation.nodeId, type: relation.type })),
  )
  return (
    <svg
      className="vision-graph"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="理解网络图谱"
    >
      {edges.map((edge, index) => {
        const from = points.get(edge.from)
        const to = points.get(edge.to)
        if (from === undefined || to === undefined) return null
        return (
          <line
            key={`${edge.from}-${edge.type}-${edge.to}-${index}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            className={`vision-graph-edge vision-edge-${edge.type}`}
          />
        )
      })}
      {nodes.map((node) => {
        const point = points.get(node.nodeId)
        if (point === undefined) return null
        const label = node.label.length > 10 ? `${node.label.slice(0, 10)}…` : node.label
        return (
          <g
            key={node.nodeId}
            className="vision-graph-node"
            role="button"
            tabIndex={0}
            aria-label={node.label}
            onClick={() => props.onSelect(node.nodeId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') props.onSelect(node.nodeId)
            }}
          >
            <circle cx={point.x} cy={point.y} r="27" />
            <text x={point.x} y={point.y + 4} textAnchor="middle">
              {label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function NetworkPage(props: {
  readonly current: Reading | undefined
  readonly selectedNode: string | undefined
  readonly query: string
  readonly guard: (work: () => Promise<unknown>) => void
}) {
  const nodes = (props.current?.understanding.nodes ?? []).filter(held)
  const [selected, setSelected] = useState<string | undefined>(props.selectedNode)
  const [tab, setTab] = useState<NetworkTab>('concepts')
  const [view, setView] = useState<'graph' | 'list'>('graph')
  const [trail, setTrail] = useState<readonly TrailEntry[]>([])
  const shownNodes = nodes.filter((node) => matches(props.query, node.label))
  const chosen =
    shownNodes.find((node) => node.nodeId === selected) ??
    shownNodes.find((node) => node.nodeId === props.selectedNode) ??
    shownNodes[0]

  useEffect(() => {
    setSelected(props.selectedNode)
  }, [props.selectedNode])

  useEffect(() => {
    if (props.current === undefined || chosen === undefined) {
      setTrail([])
      return undefined
    }
    let active = true
    const space = props.current.space.id
    const node = chosen.nodeId
    props.guard(async () => {
      const reply = await api.trail(space, node)
      if (active) setTrail(reply.trail)
    })
    return () => {
      active = false
    }
  }, [props.current?.space.id, chosen?.nodeId, props.guard])

  const selectNode = (node: string): void => {
    setSelected(node)
    if (props.current !== undefined) {
      window.location.hash = visionHref('network', props.current.space.id, node)
    }
  }
  const relations = chosen?.relations ?? []
  const materials = props.current?.materials ?? []
  const dimensions = props.current?.understanding.dimensions ?? []

  return (
    <div className="network-layout">
      <div className="vision-column">
        <section className="vision-card vision-toolbar">
          <div className="vision-tabs" role="tablist" aria-label="知识网络视图">
            {NETWORK_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className="vision-tab"
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="vision-view-toggle" aria-label="展示方式">
            <button
              type="button"
              className={view === 'graph' ? 'active' : undefined}
              aria-pressed={view === 'graph'}
              onClick={() => setView('graph')}
            >
              图谱视图
            </button>
            <button
              type="button"
              className={view === 'list' ? 'active' : undefined}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              列表视图
            </button>
          </div>
        </section>

        <section className="vision-card vision-network-canvas">
          <div className="vision-card-head">
            <h2>理解网络图谱</h2>
            <span className="hint">{shownNodes.length} 个概念</span>
          </div>
          {view === 'graph' ? (
            <NetworkGraph nodes={shownNodes} onSelect={selectNode} />
          ) : (
            <ul className="vision-node-list">
              {shownNodes.length === 0 ? (
                <li className="hint">没有匹配的概念。</li>
              ) : (
                shownNodes.map((node) => (
                  <li key={node.nodeId}>
                    <button type="button" onClick={() => selectNode(node.nodeId)}>
                      {node.label}
                    </button>
                    <span>{node.relations.length} 条关联</span>
                  </li>
                ))
              )}
            </ul>
          )}
          {view === 'graph' && shownNodes.length === 0 && (
            <p className="hint">确认候选理解后，图谱会显示真实节点。</p>
          )}
        </section>

        <section className="vision-card">
          <h2>{NETWORK_TABS.find((item) => item.id === tab)?.label ?? '概念'}</h2>
          {tab === 'concepts' && (
            <ul className="vision-plain-list">
              {shownNodes.length === 0 ? (
                <li className="hint">当前空间还没有已确认的概念。</li>
              ) : (
                shownNodes.map((node) => <li key={node.nodeId}>{node.label}</li>)
              )}
            </ul>
          )}
          {tab === 'relations' && (
            <ul className="vision-plain-list">
              {relations.length === 0 ? (
                <li className="hint">选中的节点还没有关系。</li>
              ) : (
                relations.map((relation, index) => (
                  <li key={`${relation.type}-${relation.nodeId}-${index}`}>
                    {relation.direction === 'out' ? '指向' : '来自'} {relation.label} ·{' '}
                    {relation.type}
                  </li>
                ))
              )}
            </ul>
          )}
          {tab === 'timeline' && (
            <ol className="vision-timeline">
              {trail.length === 0 ? (
                <li className="hint">暂无演化记录。</li>
              ) : (
                trail.map((entry, index) => (
                  <li key={`${entry.kind}-${entry.at}-${index}`}>
                    <time>{shortDay(entry.at)}</time>
                    <span>{trailWords(entry, dimensions)}</span>
                  </li>
                ))
              )}
            </ol>
          )}
          {tab === 'sources' && (
            <ul className="vision-plain-list">
              {materials.length === 0 ? (
                <li className="hint">这个空间还没有材料。</li>
              ) : (
                materials.map((material) => <li key={material.id}>{material.title}</li>)
              )}
              {chosen?.origin?.thread !== undefined && <li>来源对话：{chosen.origin.thread}</li>}
            </ul>
          )}
        </section>
      </div>

      <aside className="vision-card vision-node-detail">
        <h2>节点详情</h2>
        {chosen === undefined ? (
          <p className="hint">从图谱或列表中选择一个节点。</p>
        ) : (
          <>
            <h3>{chosen.label}</h3>
            <p className="hint">{wordsOf(chosen.origin?.basis, chosen.wordsBy)}</p>
            {chosen.excerpt !== undefined && chosen.excerpt !== chosen.label && (
              <blockquote>“{chosen.excerpt}”</blockquote>
            )}
            <section>
              <h4>来源追踪</h4>
              <ul className="vision-plain-list">
                <li>来源类型：{chosen.adoptedFrom === undefined ? '当前空间' : '共享成果'}</li>
                <li>提出时间：{dayOf(chosen.origin?.at)}</li>
                {chosen.origin?.thread !== undefined && <li>对话：{chosen.origin.thread}</li>}
                {chosen.origin?.turn !== undefined && <li>原话：{chosen.origin.turn}</li>}
                {chosen.adoptedFrom !== undefined && <li>原作者：{chosen.adoptedFrom.author}</li>}
              </ul>
            </section>
            <section>
              <h4>演化时间线</h4>
              <ol className="vision-timeline">
                {trail.length === 0 ? (
                  <li className="hint">这条理解还没有后续演化。</li>
                ) : (
                  trail.map((entry, index) => (
                    <li key={`detail-${entry.kind}-${entry.at}-${index}`}>
                      <time>{shortDay(entry.at)}</time>
                      <span>{trailWords(entry, dimensions)}</span>
                    </li>
                  ))
                )}
              </ol>
            </section>
            <div className="vision-detail-actions">
              <a
                className="vision-button secondary"
                href={visionHref('learning-flow', props.current?.space.id)}
              >
                加入学习流程
              </a>
              <a
                className="vision-button secondary"
                href={visionHref('shared-outcomes', props.current?.space.id)}
              >
                发布到共享空间
              </a>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}

function ReviewCenterPage(props: {
  readonly data: VisionData
  readonly query: string
  readonly busy: boolean
  readonly run: Run
}) {
  const entries = props.data.readings.flatMap((reading) =>
    reading.understanding.pending.map((candidate) => ({ reading, candidate })),
  )
  const filtered = entries.filter(({ reading, candidate }) =>
    matches(props.query, reading.space.name, candidateLabel(candidate), candidate.rationale),
  )
  const [selectedId, setSelectedId] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState('')
  const [merging, setMerging] = useState(false)
  const [targetId, setTargetId] = useState<string>()
  const selected =
    entries.find(({ candidate }) => candidate.id === selectedId) ?? filtered[0] ?? entries[0]
  const targets =
    selected === undefined ? [] : selected.reading.understanding.nodes.filter((node) => held(node))
  const target = targets.find((node) => node.nodeId === targetId) ?? targets[0]

  useEffect(() => {
    if (selected !== undefined) setLabel(candidateLabel(selected.candidate))
  }, [selected?.candidate.id])

  useEffect(() => {
    setTargetId(target?.nodeId)
  }, [target?.nodeId])

  const accept = (): void => {
    if (selected === undefined) return
    const { candidate } = selected
    props.run(async () => {
      await api.accept(candidate.id)
      setSelectedId(undefined)
      setEditing(false)
      setMerging(false)
    })
  }
  const dismiss = (): void => {
    if (selected === undefined) return
    const { candidate } = selected
    props.run(async () => {
      await api.dismiss(candidate.id)
      setSelectedId(undefined)
      setEditing(false)
      setMerging(false)
    })
  }
  const saveEdited = (): void => {
    if (selected === undefined || label.trim() === '') return
    const { candidate } = selected
    props.run(async () => {
      await api.acceptEdited(candidate, label.trim())
      setSelectedId(undefined)
      setEditing(false)
    })
  }
  const merge = (): void => {
    if (selected === undefined || target === undefined) return
    const { candidate, reading } = selected
    const candidateWords = candidateLabel(candidate)
    const combined = `${target.label}；${candidateWords}`.slice(0, 180)
    props.run(async () => {
      const revised = await api.revise(
        reading.space.id,
        target.nodeId,
        combined === target.label ? `${combined}（候选合并）` : combined,
        `合并候选理解：${candidate.rationale}`.slice(0, 200),
      )
      for (const suggestion of revised.suggestions) await api.accept(suggestion.id)
      await api.dismiss(candidate.id)
      setSelectedId(undefined)
      setMerging(false)
    })
  }

  const related =
    selected === undefined
      ? []
      : selected.reading.understanding.nodes
          .filter(held)
          .filter((node) =>
            selected.candidate.similar === undefined
              ? node.label.includes(candidateLabel(selected.candidate).slice(0, 4))
              : node.label === selected.candidate.similar,
          )
          .slice(0, 4)

  return (
    <div className="review-layout">
      <section className="vision-card review-queue">
        <div className="vision-card-head">
          <h2>候选理解队列</h2>
          <span className="hint">{entries.length} 条</span>
        </div>
        <ul className="vision-candidate-list">
          {filtered.length === 0 ? (
            <li className="hint">当前没有匹配的候选理解。</li>
          ) : (
            filtered.map(({ reading, candidate }) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-current={selected?.candidate.id === candidate.id ? 'true' : undefined}
                  onClick={() => {
                    setSelectedId(candidate.id)
                    setEditing(false)
                    setMerging(false)
                  }}
                >
                  <strong>{candidateLabel(candidate)}</strong>
                  <span>
                    来自 {reading.space.name} · {wordsOf(candidate.basis, candidate.wordsBy)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="vision-card review-detail">
        <h2>候选理解详情</h2>
        {selected === undefined ? (
          <p className="hint">AI 提出的候选会出现在这里，等待你的决定。</p>
        ) : (
          <>
            <h3>{candidateLabel(selected.candidate)}</h3>
            <p className="vision-rule">AI 只提出候选；只有你接受或修改后，它才会成为理解。</p>
            <dl className="vision-facts">
              <dt>所属空间</dt>
              <dd>{selected.reading.space.name}</dd>
              <dt>提出者</dt>
              <dd>{selected.candidate.proposedBy ?? '未记录'}</dd>
              <dt>提出时间</dt>
              <dd>{dayOf(selected.candidate.proposedAt)}</dd>
              <dt>理由</dt>
              <dd>{selected.candidate.rationale}</dd>
            </dl>
            <section className="vision-evidence">
              <h4>来源证据</h4>
              <p>{wordsOf(selected.candidate.basis, selected.candidate.wordsBy)}</p>
              <blockquote>
                {selected.candidate.origin?.excerpt ?? selected.candidate.rationale}
              </blockquote>
              {selected.candidate.origin?.turn !== undefined && (
                <p className="hint">证据来自对话中的原话：{selected.candidate.origin.turn}</p>
              )}
            </section>
            {editing && (
              <div className="vision-form">
                <label>
                  修改后的理解
                  <textarea
                    aria-label="修改候选理解"
                    rows={3}
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="vision-button"
                  disabled={props.busy || label.trim() === ''}
                  onClick={saveEdited}
                >
                  保存修改后的理解
                </button>
              </div>
            )}
            {merging && (
              <div className="vision-form">
                <label>
                  合并到
                  <select
                    aria-label="选择已有节点"
                    value={target?.nodeId ?? ''}
                    onChange={(event) => setTargetId(event.target.value)}
                  >
                    {targets.map((node) => (
                      <option key={node.nodeId} value={node.nodeId}>
                        {node.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="vision-button"
                  disabled={props.busy || target === undefined}
                  onClick={merge}
                >
                  确认合并
                </button>
              </div>
            )}
            <div className="review-actions">
              <button
                type="button"
                className="vision-button"
                disabled={props.busy || selected.candidate.link?.ready === false}
                onClick={accept}
              >
                接受
              </button>
              <button
                type="button"
                className="vision-button secondary"
                disabled={props.busy || selected.candidate.link !== undefined}
                onClick={() => setEditing((open) => !open)}
              >
                需要修改
              </button>
              <button
                type="button"
                className="vision-button secondary"
                disabled={props.busy}
                onClick={dismiss}
              >
                暂不纳入
              </button>
              <button
                type="button"
                className="vision-button secondary"
                disabled={props.busy || targets.length === 0}
                onClick={() => setMerging((open) => !open)}
              >
                合并到已有节点
              </button>
            </div>
          </>
        )}
      </section>

      <aside className="vision-card review-impact">
        <h2>影响预览</h2>
        {selected === undefined ? (
          <p className="hint">选择一条候选后，这里会显示它会连接到哪些已有理解。</p>
        ) : (
          <>
            <p>
              接受后会把“{candidateLabel(selected.candidate)}”写入 {selected.reading.space.name}
              的理解网络。
            </p>
            <div className="impact-map">
              <span className="impact-center">{candidateLabel(selected.candidate)}</span>
              {related.map((node) => (
                <span key={node.nodeId} className="impact-node">
                  {node.label}
                </span>
              ))}
            </div>
            <h3>可能带来的价值</h3>
            <ul className="vision-plain-list">
              <li>保留候选的原话、理由和来源证据。</li>
              <li>让后续学习流程可以复用这条已确认理解。</li>
            </ul>
            <h3>相关现有节点（可合并）</h3>
            {targets.length === 0 ? (
              <p className="hint">当前空间还没有可合并的已确认节点。</p>
            ) : (
              <ul className="vision-plain-list">
                {targets.slice(0, 4).map((node) => (
                  <li key={node.nodeId}>{node.label}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </aside>
    </div>
  )
}

interface FlowStep {
  readonly id: string
  readonly label: string
  readonly status: Step['status']
  readonly minutes: number
}

function LearningFlowPage(props: {
  readonly current: Reading | undefined
  readonly planId: string | undefined
  readonly blocks: readonly BlockInfo[]
  readonly workflows: readonly WorkflowInfo[]
  readonly query: string
  readonly busy: boolean
  readonly run: Run
}) {
  const [answer, setAnswer] = useState('')
  const [saved, setSaved] = useState<string>()
  const plans = props.current?.plans ?? []
  const plan =
    plans.find((candidate) => candidate.id === props.planId) ??
    plans.find((candidate) => candidate.status === 'active') ??
    plans[0]
  const steps: readonly FlowStep[] =
    plan === undefined
      ? props.blocks.slice(0, 6).map((block, index) => ({
          id: block.id,
          label: block.title,
          status: index === 0 ? 'active' : 'pending',
          minutes: 0,
        }))
      : plan.steps.map((step) => ({
          id: step.id,
          label: `${step.focus} · ${props.blocks.find((block) => block.id === step.block)?.title ?? step.block}`,
          status: step.status,
          minutes: step.minutes,
        }))
  const done = steps.filter((step) => step.status === 'done').length
  const progress = steps.length === 0 ? 0 : Math.round((done / steps.length) * 100)
  const currentStep = steps.find((step) => step.status === 'active') ?? steps[0]
  const concepts = (props.current?.understanding.nodes ?? [])
    .filter(held)
    .filter((node) => matches(props.query, node.label))
    .slice(0, 6)
  const materials = (props.current?.materials ?? []).filter((material) =>
    matches(props.query, material.title),
  )
  const workflow = props.workflows.find((candidate) => candidate.id === plan?.workflow)

  const save = (): void => {
    const words = answer.trim()
    if (props.current === undefined || words === '') return
    const space = props.current.space.id
    props.run(async () => {
      await api.saveUnderstanding(space, words)
      setAnswer('')
      setSaved(words)
    })
  }

  return (
    <div className="learning-layout">
      <div className="vision-column">
        <section className="vision-card vision-steps-card">
          <h2>步骤进度</h2>
          <ol className="vision-steps">
            {steps.length === 0 ? (
              <li className="hint">当前服务没有可用的学习活动。</li>
            ) : (
              steps.map((step, index) => (
                <li key={step.id} data-status={step.status}>
                  <span className="step-number">{index + 1}</span>
                  <strong>{step.label}</strong>
                  <span>{step.minutes > 0 ? `${step.minutes} 分钟` : statusWord(step.status)}</span>
                </li>
              ))
            )}
          </ol>
        </section>

        <section className="vision-card learning-task">
          <div className="vision-card-head">
            <h2>当前目标：{currentStep?.label ?? '先选定一个学习空间'}</h2>
            <span className="hint">{workflow?.title ?? '引导式学习'}</span>
          </div>
          <div className="vision-split">
            <div className="vision-subcard">
              <h3>AI 学习引导</h3>
              <p>
                {props.current === undefined
                  ? '先建一个空间并加入资料，才能开始有依据的学习。'
                  : `围绕“${currentStep?.label ?? plan?.topic ?? props.current.space.name}”用自己的话写出当前理解，再保存为可复用的节点。`}
              </p>
            </div>
            <div className="vision-subcard">
              <h3>本轮目标</h3>
              <p>
                解释 {currentStep?.label ?? plan?.topic ?? '当前主题'}
                ，并把回答与已有概念和资料联系起来。
              </p>
              <div className="vision-tags">
                {concepts.map((node) => (
                  <span key={node.nodeId}>{node.label}</span>
                ))}
              </div>
            </div>
          </div>
          <label className="vision-answer">
            你的回答
            <textarea
              aria-label="你的回答"
              rows={5}
              value={answer}
              placeholder="在这里输入你的思考与回答…"
              onChange={(event) => setAnswer(event.target.value)}
            />
          </label>
          <div className="learning-actions">
            <button
              type="button"
              className="vision-button"
              disabled={props.busy || answer.trim() === '' || props.current === undefined}
              onClick={save}
            >
              保存为可复用的理解节点
            </button>
            {plan !== undefined && props.current !== undefined && (
              <a
                className="vision-button secondary"
                href={`${legacySpaceHref(props.current.space.id)}/plans/${encodeURIComponent(plan.id)}`}
              >
                打开完整学习计划
              </a>
            )}
          </div>
          {saved !== undefined && (
            <p className="vision-saved" role="status">
              已保存为可复用节点：{saved}
            </p>
          )}
        </section>
      </div>

      <aside className="vision-column">
        <section className="vision-card">
          <h2>学习进度</h2>
          <div className="vision-progress">
            <div
              className="vision-progress-bar"
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <span>
              {done} / {steps.length} 步
            </span>
          </div>
          <ul className="vision-plain-list">
            {steps.map((step) => (
              <li key={step.id} data-status={step.status}>
                {statusWord(step.status)} · {step.label}
              </li>
            ))}
          </ul>
        </section>
        <section className="vision-card">
          <h2>当前目标</h2>
          <p>{currentStep?.label ?? '选择一个空间与学习流程'}</p>
          <p className="hint">已确认理解：{props.current?.status.confirmed ?? 0} 条</p>
        </section>
        <section className="vision-card">
          <h2>关键概念</h2>
          <div className="vision-tags">
            {concepts.length === 0 ? (
              <span>还没有已确认概念</span>
            ) : (
              concepts.map((node) => <span key={node.nodeId}>{node.label}</span>)
            )}
          </div>
        </section>
        <section className="vision-card">
          <h2>快速参考资料</h2>
          <ul className="vision-plain-list">
            {materials.length === 0 ? (
              <li className="hint">当前空间还没有资料。</li>
            ) : (
              materials
                .slice(0, 4)
                .map((material) => <li key={material.id}>{materialWords(material)}</li>)
            )}
          </ul>
        </section>
        <section className="vision-card">
          <h2>最终输出预览</h2>
          <p>{answer.trim() === '' ? '你的回答会显示在这里。' : answer}</p>
          <p className="hint">
            保存后会获得一个由你署名、可复用的理解节点；AI 候选仍须在审阅中心确认。
          </p>
        </section>
      </aside>
    </div>
  )
}

const statusWord = (status: Step['status']): string => {
  if (status === 'done') return '已完成'
  if (status === 'active') return '进行中'
  if (status === 'skipped') return '已跳过'
  return '待开始'
}

function SharedOutcomesPage(props: {
  readonly data: VisionData
  readonly me: Me
  readonly query: string
}) {
  const publications = props.data.publications.filter((publication) =>
    matches(props.query, publication.rootLabel, publication.author),
  )
  const reusable = props.data.readings.flatMap((reading) =>
    reading.understanding.nodes.filter(held).map((node) => ({ reading, node })),
  )
  const shownReusable = reusable.filter(({ reading, node }) =>
    matches(props.query, reading.space.name, node.label),
  )
  return (
    <div className="vision-two-column">
      <section className="vision-card">
        <div className="vision-card-head">
          <h2>共享成果</h2>
          {props.me.sharing && <a href="#/commons">浏览公开成果 →</a>}
        </div>
        <p className="hint">
          {props.me.sharing
            ? '按成果名或作者查看已经发布的理解结构。'
            : '当前服务没有开启公开共享；已确认的理解仍可在自己的空间里复用。'}
        </p>
        {publications.length === 0 ? (
          <p>当前没有匹配的公开成果。</p>
        ) : (
          <ul className="vision-space-list">
            {publications.map((publication) => (
              <li key={publication.id}>
                <div>
                  <strong>{publication.rootLabel}</strong>
                  <span>
                    {props.me.names[publication.author] ?? publication.author} ·{' '}
                    {publication.members} 个节点 · 第 {publication.version} 版
                  </span>
                </div>
                <a
                  className="vision-button secondary"
                  href={`#/commons/${encodeURIComponent(publication.id)}`}
                >
                  查看详情
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <aside className="vision-card">
        <h2>你的可复用理解</h2>
        <ul className="vision-plain-list">
          {shownReusable.length === 0 ? (
            <li className="hint">还没有匹配的理解节点。</li>
          ) : (
            shownReusable.map(({ reading, node }) => (
              <li key={node.nodeId}>
                <a href={visionHref('network', reading.space.id, node.nodeId)}>{node.label}</a>
                <span className="hint"> · {reading.space.name}</span>
              </li>
            ))
          )}
        </ul>
      </aside>
    </div>
  )
}

function MyMaterialsPage(props: { readonly data: VisionData; readonly query: string }) {
  const materials = props.data.readings.flatMap((reading) =>
    reading.materials.map((material) => ({ reading, material })),
  )
  const shown = materials.filter(({ reading, material }) =>
    matches(props.query, reading.space.name, material.title),
  )
  return (
    <div className="vision-two-column">
      <section className="vision-card">
        <div className="vision-card-head">
          <h2>我的资料</h2>
          <span className="hint">{shown.length} 份</span>
        </div>
        <ul className="vision-space-list">
          {shown.length === 0 ? (
            <li className="hint">当前没有匹配的资料。</li>
          ) : (
            shown.map(({ reading, material }) => (
              <li key={material.id}>
                <div>
                  <strong>{material.title}</strong>
                  <span>
                    {reading.space.name} · {materialWords(material)}
                  </span>
                </div>
                <a
                  className="vision-button secondary"
                  href={`${legacySpaceHref(reading.space.id)}/materials`}
                >
                  打开资料
                </a>
              </li>
            ))
          )}
        </ul>
      </section>
      <aside className="vision-card">
        <h2>按空间整理</h2>
        <ul className="vision-plain-list">
          {props.data.readings.length === 0 ? (
            <li className="hint">先创建一个学习空间。</li>
          ) : (
            props.data.readings.map((reading) => (
              <li key={reading.space.id}>
                <a href={visionHref('my-materials', reading.space.id)}>{reading.space.name}</a> ·{' '}
                {reading.materials.length} 份资料
              </li>
            ))
          )}
        </ul>
        <a className="vision-button secondary" href={visionHref('learning-spaces')}>
          管理学习空间
        </a>
      </aside>
    </div>
  )
}

interface ClientInfo {
  readonly agents:
    | { readonly agents: readonly AgentInfo[]; readonly others: readonly AgentUse[] }
    | undefined
  readonly sessions:
    | {
        readonly agents: readonly {
          readonly id: string
          readonly name: string
          readonly found: boolean
        }[]
        readonly sessions: readonly AgentSessionInfo[]
      }
    | undefined
  readonly conversations: readonly ConversationInfo[]
  readonly unfiled: number
  readonly model: ModelInfo
}

function ClientPage(props: {
  readonly me: Me
  readonly data: VisionData
  readonly spaces: readonly Space[]
  readonly current: Reading | undefined
  readonly guard: (work: () => Promise<unknown>) => void
  readonly busy: boolean
  readonly run: Run
  readonly reloadKey: number
}) {
  const [info, setInfo] = useState<ClientInfo>()
  const [selected, setSelected] = useState(0)
  const [imported, setImported] = useState<number>()

  useEffect(() => {
    let active = true
    props.guard(async () => {
      const local = props.me.mode === 'local'
      const [agents, sessions, conversations, unfiled, model] = await Promise.all([
        local ? api.agents() : Promise.resolve(undefined),
        local ? api.agentSessions(undefined, '') : Promise.resolve(undefined),
        api.conversations(false),
        api.unfiled(),
        api.model(),
      ])
      if (active) {
        setInfo({
          agents,
          sessions,
          conversations: conversations.conversations,
          unfiled: unfiled.pending.length,
          model,
        })
        setSelected(0)
      }
    })
    return () => {
      active = false
    }
  }, [props.me.mode, props.guard, props.reloadKey])

  const confirmedNodes = props.data.readings.reduce(
    (count, reading) => count + reading.understanding.nodes.filter(held).length,
    0,
  )
  const pendingCandidates = props.data.readings.reduce(
    (count, reading) => count + reading.understanding.pending.length,
    0,
  )
  const sessions = info?.sessions?.sessions ?? []
  const selectedSession = sessions[selected]
  const agentName = (id: string): string =>
    info?.sessions?.agents.find((agent) => agent.id === id)?.name ?? id
  const installed = info?.agents?.agents.filter((agent) => agent.installed).length ?? 0
  const connected =
    info?.agents?.agents.filter((agent) => agent.installed && agent.connected === true).length ?? 0
  const otherClients = info?.agents?.others.length ?? 0
  const foundAgents = info?.sessions?.agents.filter((agent) => agent.found).length ?? 0
  const mcp =
    info?.agents?.agents.find((agent) => agent.address !== '')?.address ??
    `${window.location.origin}/mcp`
  const modelName = info?.model.simulated === false ? (info.model.name ?? '已设置模型') : '模拟模型'

  const importSession = (): void => {
    const session = selectedSession
    const space = props.current?.space.id
    if (session === undefined || space === undefined) return
    props.run(async () => {
      const detail = await api.agentSession(session.agent, session.id)
      const transcript = detail.session.messages
        .map((message) => {
          const speaker =
            message.role === 'user' ? '学习者' : message.role === 'assistant' ? 'Agent' : '工具'
          return `${speaker}：${message.text.replace(/\s+/g, ' ').trim()}`
        })
        .join('\n\n')
      const title = `Agent 会话：${detail.session.summary.title}`
      const offered = await api.distillTranscript(
        space,
        title,
        `# ${detail.session.summary.title}\n\n${transcript}`,
      )
      setImported(offered.suggestions.length)
    })
  }

  return (
    <div className="vision-two-column client-layout">
      <div className="vision-column">
        <section className="vision-card client-hero">
          <h2>统一全局记忆</h2>
          <p>
            本机 Agent 通过同一个 MCP
            入口读取和提出候选，服务把确认后的理解保存在同一图谱中。当前图谱覆盖{' '}
            {props.spaces.length} 个空间。
          </p>
          <div className="vision-stat-row">
            <Stat label="已确认理解" value={String(confirmedNodes)} name="client-nodes" />
            <Stat label="学习空间" value={String(props.spaces.length)} name="client-spaces" />
            <Stat label="待确认候选" value={String(pendingCandidates)} name="client-pending" />
          </div>
          <dl className="vision-facts client-facts">
            <dt>MCP 入口</dt>
            <dd>{mcp}</dd>
            <dt>当前空间</dt>
            <dd>{props.current?.space.name ?? '还没有空间'}</dd>
            <dt>运行模式</dt>
            <dd>{props.me.mode === 'local' ? '本机单人模式' : '共享服务模式'}</dd>
          </dl>
          <a
            className="vision-button secondary"
            href={visionHref('review-center', props.current?.space.id)}
          >
            查看审阅中心
          </a>
        </section>

        <section className="vision-card">
          <h2>导入对话历史</h2>
          <p className="hint">
            选择本机 Agent 保存的一段会话，按学习者 / Agent
            角色整理后蒸馏成当前空间的候选理解。候选进入审阅队列，由你确认后写入图谱。
          </p>
          {props.me.mode === 'shared' ? (
            <p>共享服务模式下，本机 Agent 会话由运行服务的电脑管理。</p>
          ) : sessions.length === 0 ? (
            <p>当前没有可读的 Agent 会话。接入本机 Agent 后，它保存的会话会出现在这里。</p>
          ) : (
            <div className="client-import">
              <label>
                选择会话
                <select
                  aria-label="选择 Agent 会话"
                  value={selected}
                  onChange={(event) => setSelected(Number(event.target.value))}
                >
                  {sessions.map((session, index) => (
                    <option key={`${session.agent}-${session.id}`} value={index}>
                      {agentName(session.agent)} · {session.title}
                      {session.project === undefined ? '' : ` · ${session.project}`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="vision-button"
                disabled={props.busy || props.current === undefined}
                onClick={importSession}
              >
                导入为待确认理解
              </button>
            </div>
          )}
          {imported !== undefined && (
            <p className="vision-saved" role="status">
              已导入 {imported} 条候选理解，等待你在审阅中心确认。
            </p>
          )}
          <div className="client-links">
            <a href="#/agent-sessions">浏览 Agent 会话记录</a>
            <a href={visionHref('review-center', props.current?.space.id)}>
              打开当前空间的审阅中心
            </a>
          </div>
        </section>
      </div>

      <div className="vision-column">
        <section className="vision-card">
          <h2>接入本机 Agent</h2>
          <div className="vision-stat-row">
            <Stat label="已安装" value={String(installed)} name="agents-installed" />
            <Stat label="已接入" value={String(connected)} name="agents-connected" />
            <Stat label="其他客户端" value={String(otherClients)} name="agents-others" />
          </div>
          <p className="hint">
            Agent 只能读取和提出候选；确认、修改、保存和发布都由你完成。可识别 {foundAgents}{' '}
            个本机会话来源。
          </p>
          <a className="vision-button secondary" href="#/connect">
            打开接入 Agent 页面
          </a>
        </section>

        <section className="vision-card">
          <h2>原有能力</h2>
          <div className="client-links">
            <a href="#/conversations">打开所有对话 · {info?.conversations.length ?? 0} 条</a>
            <a href="#/agent-sessions">浏览 Agent 会话记录 · {sessions.length} 条</a>
            <a href="#/unfiled">处理未分类候选 · {info?.unfiled ?? 0} 条</a>
            <a href="#/model">打开模型设置 · {modelName}</a>
            <a href="#/commons">浏览共享成果</a>
          </div>
        </section>

        <section className="vision-card">
          <h2>桌面客户端</h2>
          <p>
            Tauri 桌面程序携带自己的 Node 运行时和同一个 workbench 服务。它使用默认图谱与 4322
            端口；窗口关闭后服务仍留在托盘，供已接入的本机 Agent 继续使用。
          </p>
          <p className="hint">
            开发启动命令：<code>pnpm --filter @episteme/desktop dev</code>
          </p>
        </section>
      </div>
    </div>
  )
}
