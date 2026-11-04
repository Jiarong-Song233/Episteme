import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { useContext, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  api,
  type Challenge,
  type Dimension,
  type HeldNode,
  type TrailEntry,
  type Understanding,
  type WordsBy,
} from './api.js'
import { Lineage, PublishFlow } from './Commons.js'
import { Links, messageOf } from './Turns.js'

/** What a person holds: every item with where it came from, what happened to it, and what they can do about it. */

const RELATION_WORDS: Readonly<Record<string, string>> = {
  evolves_to: '修正为',
  contradicts: '和这条矛盾',
  supports: '支持',
}

const whenOf = (at: number): string =>
  new Date(at).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

const byWhom = (by: string): string => (by === 'self' ? '你自己' : '模型')

/** Whose words these are, as far as the record can say. Relayed words stay usable, and the person judges them. */
export function wordsOf(basis: string | undefined, wordsBy: WordsBy | undefined): string {
  if (basis === 'inferred') return '模型的话'
  if (basis !== 'stated') return '来源未记录'
  if (wordsBy === 'person') return '你的原话'
  return wordsBy === 'agent' ? 'Agent 转述' : '来源未记录'
}

function proposedWords(speaker: string, basis: string | undefined, wordsBy: WordsBy | undefined) {
  if (speaker !== 'learner') return '从模型的话里提炼，经你确认。'
  if (wordsBy === 'agent') return 'Agent 转述的话，经你确认。'
  return wordsBy === 'person' || basis === undefined ? '你提出这一条。' : '来源未记录，经你确认。'
}

interface PanelProps {
  readonly space: string
  readonly understanding: Understanding
  readonly selected: string | undefined
  readonly simulated: boolean
  readonly guard: (work: () => Promise<unknown>) => void
  readonly onSelect: (node: string | undefined) => void
  readonly onChanged: () => Promise<void>
  readonly onJump: (thread: string, turn: string | undefined) => void
}

export function UnderstandingPanel(props: PanelProps) {
  const { understanding, selected } = props
  const node = understanding.nodes.find((candidate) => candidate.nodeId === selected)
  if (node !== undefined) return <NodeDetail {...props} node={node} />
  if (understanding.nodes.length === 0) {
    return <p className="hint">这里只放你亲自确认过的内容。还没有。</p>
  }
  const current = understanding.nodes.filter((held) => isHeld(held))
  const past = understanding.nodes.filter((held) => !isHeld(held))
  return (
    <>
      <UnderstandingMap nodes={understanding.nodes} onSelect={props.onSelect} />
      <ul className="understood">
        {current.map((held) => (
          <NodeRow key={held.nodeId} node={held} onSelect={props.onSelect} />
        ))}
      </ul>
      {current.length === 0 && <p className="hint">你现在没有持有的理解了，它们都被修正或撤回。</p>}
      {past.length > 0 && (
        <details className="past">
          <summary>已修正或撤回（{past.length}）</summary>
          <ul className="understood">
            {past.map((held) => (
              <NodeRow key={held.nodeId} node={held} onSelect={props.onSelect} />
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

const isHeld = (node: HeldNode): boolean => node.revisedTo === undefined && !node.withdrawn

function NodeRow({ node, onSelect }: { node: HeldNode; onSelect: (node: string) => void }) {
  return (
    <li data-held={isHeld(node)}>
      <button type="button" className="node-row" onClick={() => onSelect(node.nodeId)}>
        {node.label}
      </button>
      <Marks node={node} />
    </li>
  )
}

function Marks({ node }: { node: HeldNode }) {
  const links = useContext(Links)
  const marks = [
    node.adoptedFrom === undefined ? undefined : `引用自 ${links.nameOf(node.adoptedFrom.author)}`,
    node.conflict ? '未解决的矛盾' : undefined,
    node.openChallenges > 0 ? `${node.openChallenges} 条质疑待回应` : undefined,
    node.revisedTo === undefined ? undefined : '已修正',
    node.withdrawn ? '已撤回' : undefined,
  ].filter((mark) => mark !== undefined)
  if (marks.length === 0) return null
  return (
    <p className="marks">
      {marks.map((mark) => (
        <span key={mark}>{mark}</span>
      ))}
    </p>
  )
}

interface Point extends SimulationNodeDatum {
  readonly node: HeldNode
}

const MAP_WIDTH = 320
const MAP_HEIGHT = 220
const SHORT_LABEL = 8

/**
 * The same items as the list below it, placed by what connects them.
 *
 * Laid out once, not animated: it shows structure, and something that moves is hard to point at. It is hidden from
 * assistive technology because the list says all of it, with its relations on each item's page.
 */
function UnderstandingMap({
  nodes,
  onSelect,
}: {
  nodes: readonly HeldNode[]
  onSelect: (node: string) => void
}) {
  const { points, edges } = useMemo(() => {
    const placed: Point[] = nodes.map((node) => ({ node }))
    const known = new Set(nodes.map((node) => node.nodeId))
    const links: (SimulationLinkDatum<Point> & { type: string })[] = nodes.flatMap((node) =>
      node.relations
        .filter((relation) => relation.direction === 'out' && known.has(relation.nodeId))
        .map((relation) => ({ source: node.nodeId, target: relation.nodeId, type: relation.type })),
    )
    forceSimulation(placed)
      .force('charge', forceManyBody().strength(-90))
      .force(
        'link',
        forceLink<Point, (typeof links)[number]>(links)
          .id((point) => point.node.nodeId)
          .distance(70),
      )
      .force('center', forceCenter(MAP_WIDTH / 2, MAP_HEIGHT / 2))
      .force('collide', forceCollide(26))
      .stop()
      .tick(200)
    return { points: placed, edges: links }
  }, [nodes])
  if (nodes.length < 2) return null
  const inside = (value: number | undefined, max: number): number =>
    Math.min(max - 14, Math.max(14, value ?? max / 2))
  return (
    <figure className="map">
      <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} aria-hidden="true">
        <defs>
          <marker
            id="map-arrow"
            viewBox="0 0 8 8"
            refX="12"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0 0 L8 4 L0 8 z" className="map-arrow" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const source = edge.source as Point
          const target = edge.target as Point
          return (
            <line
              key={`${source.node.nodeId}-${edge.type}-${target.node.nodeId}`}
              className={`map-edge map-${edge.type}`}
              x1={inside(source.x, MAP_WIDTH)}
              y1={inside(source.y, MAP_HEIGHT)}
              x2={inside(target.x, MAP_WIDTH)}
              y2={inside(target.y, MAP_HEIGHT)}
              {...(edge.type === 'evolves_to' || edge.type === 'forks_from'
                ? { markerEnd: 'url(#map-arrow)' }
                : {})}
            />
          )
        })}
        {points.map((point) => {
          const { node } = point
          const x = inside(point.x, MAP_WIDTH)
          const y = inside(point.y, MAP_HEIGHT)
          return (
            // biome-ignore lint: the list below is the keyboard path to the same pages
            <g key={node.nodeId} className="map-node" onClick={() => onSelect(node.nodeId)}>
              <title>{node.label}</title>
              <circle cx={x} cy={y} r={7} data-held={isHeld(node)} data-conflict={node.conflict} />
              <text x={x} y={y + 19} textAnchor="middle">
                {node.label.length > SHORT_LABEL
                  ? `${node.label.slice(0, SHORT_LABEL)}…`
                  : node.label}
              </text>
            </g>
          )
        })}
      </svg>
      <figcaption className="hint">
        实线：支持。粗虚线：矛盾。箭头：修正或分叉。黄点：有未解决的矛盾。空心：已修正或撤回。
      </figcaption>
    </figure>
  )
}

type Acting =
  | { readonly kind: 'revise'; readonly challenge?: string }
  | { readonly kind: 'challenge' }
  | { readonly kind: 'contradict' }
  | { readonly kind: 'publish' }

function NodeDetail(props: PanelProps & { node: HeldNode }) {
  const { node, space, understanding, guard, onChanged } = props
  const links = useContext(Links)
  const [showLineage, setShowLineage] = useState(false)
  const [trail, setTrail] = useState<readonly TrailEntry[]>([])
  const [acting, setActing] = useState<Acting>()
  const [note, setNote] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    api
      .trail(space, node.nodeId)
      .then((reply) => {
        if (current) setTrail(reply.trail)
      })
      .catch((error: unknown) => {
        if (current) setNote(messageOf(error))
      })
    return () => {
      current = false
    }
  }, [space, node.nodeId, understanding])

  const act = (work: () => Promise<unknown>): void => {
    setNote(undefined)
    setBusy(true)
    guard(async () => {
      try {
        await work()
        setActing(undefined)
        await onChanged()
      } finally {
        setBusy(false)
      }
    })
  }

  const challenges = understanding.challenges.filter((held) => held.node === node.nodeId)
  const open = challenges.filter((held) => held.status === 'open')
  const dimensions = understanding.dimensions.filter(
    (dimension) => dimension.id !== 'stance' && dimension.id !== 'conflict',
  )
  const others = understanding.nodes.filter(
    (other) => other.nodeId !== node.nodeId && isHeld(other),
  )
  const held = isHeld(node)

  const saveRevision = (label: string, reason: string, challenge: string | undefined): void => {
    act(async () => {
      // Someone else's words are not revised. The person's own version goes beside them, pointing back.
      const { suggestions } =
        node.adoptedFrom === undefined
          ? await api.revise(space, node.nodeId, label, reason)
          : await api.respond(
              space,
              node.adoptedFrom.publication,
              node.nodeId,
              label,
              'forks',
              reason,
            )
      // These are this person's own words and their own click, so the two decisions are made here, through the one
      // decision route: the new wording, then the edge from the old to it.
      for (const suggestion of suggestions) await api.accept(suggestion.id)
      const replaced = (await api.understanding(space)).nodes.find(
        (candidate) => candidate.nodeId === node.nodeId,
      )?.revisedTo
      if (challenge !== undefined) {
        await api.settleChallenge(challenge, 'revised', {
          ...(replaced === undefined ? {} : { revisedTo: replaced }),
        })
      }
      if (replaced !== undefined) props.onSelect(replaced)
    })
  }

  const askModel = (): void => {
    setNote(undefined)
    setBusy(true)
    guard(async () => {
      try {
        const reply = await api.challenge(space, node.nodeId)
        if (reply.failure !== undefined) setNote(`${reply.failure.message}可以再试一次。`)
        else if (reply.message !== undefined) setNote(reply.message)
        await onChanged()
      } finally {
        setBusy(false)
      }
    })
  }

  return (
    <article className="node-detail">
      <button type="button" className="link" onClick={() => props.onSelect(undefined)}>
        全部理解
      </button>
      <h3 className="node-label" data-held={held}>
        {node.label}
      </h3>
      <Marks node={node} />
      <p className="hint">
        {node.adoptedFrom === undefined ? (
          wordsOf(node.origin?.basis, node.wordsBy)
        ) : (
          <>
            {links.nameOf(node.adoptedFrom.author)} 发布的成果，不是你的原话。{' '}
            <button
              type="button"
              className="link"
              onClick={() => links.openPublication(node.adoptedFrom?.publication ?? '')}
            >
              看原来的成果
            </button>
          </>
        )}
        {node.excerpt !== undefined && node.excerpt !== node.label && <>：“{node.excerpt}”</>}
        {node.origin?.thread !== undefined && (
          <>
            {' '}
            <button
              type="button"
              className="link"
              onClick={() => props.onJump(node.origin?.thread ?? '', node.origin?.turn)}
            >
              回到当时的对话
            </button>
          </>
        )}
      </p>

      {open.map((challenge) => (
        <section key={challenge.id} className="challenge">
          <p>{challenge.text}</p>
          <p className="hint">
            {byWhom(challenge.by)}提出。
            {challenge.quote === undefined
              ? challenge.by === 'self'
                ? ''
                : '这是模型自己的看法，材料里没有对应的话。'
              : `材料里说：“${challenge.quote}”`}
          </p>
          <p className="decisions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setActing({ kind: 'revise', challenge: challenge.id })}
            >
              它说得对，修正
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await api.record(node.nodeId, { conflict: 'open' }, `质疑：${challenge.text}`)
                  await api.settleChallenge(challenge.id, 'conflict', {})
                })
              }
            >
              还没想通，记为矛盾
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => act(() => api.settleChallenge(challenge.id, 'dismissed', {}))}
            >
              不成立，放下
            </button>
          </p>
        </section>
      ))}

      {acting?.kind === 'revise' && (
        <Revising
          initial={node.label}
          busy={busy}
          adopted={node.adoptedFrom !== undefined}
          onCancel={() => setActing(undefined)}
          onSave={(label, reason) => saveRevision(label, reason, acting.challenge)}
        />
      )}
      {acting?.kind === 'challenge' && (
        <OneLine
          label="你的质疑"
          placeholder="比如：这在什么情况下不成立？"
          action="记下这条质疑"
          busy={busy}
          onCancel={() => setActing(undefined)}
          onSave={(text) => act(() => api.challenge(space, node.nodeId, text))}
        />
      )}
      {acting?.kind === 'contradict' && (
        <Contradicting
          others={others}
          busy={busy}
          onCancel={() => setActing(undefined)}
          onSave={(other) =>
            act(async () => {
              const { suggestions } = await api.relate(space, node.nodeId, other, 'contradicts')
              for (const suggestion of suggestions) await api.accept(suggestion.id)
              const reason = '你认为这两条互相矛盾'
              await api.record(node.nodeId, { conflict: 'open' }, reason)
              await api.record(other, { conflict: 'open' }, reason)
            })
          }
        />
      )}

      {acting?.kind === 'publish' && (
        <PublishFlow
          space={space}
          node={node.nodeId}
          fromModel={node.origin?.basis === 'inferred'}
          onCancel={() => setActing(undefined)}
          onDone={(publication) => {
            setActing(undefined)
            links.openPublication(publication)
          }}
        />
      )}

      {note !== undefined && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {busy && (
        <p className="working" role="status">
          正在处理…
        </p>
      )}

      {acting === undefined && (
        <p className="decisions">
          {held && (
            <button type="button" disabled={busy} onClick={() => setActing({ kind: 'revise' })}>
              {node.adoptedFrom === undefined ? '修正' : '提出我的版本'}
            </button>
          )}
          {held && links.sharing && node.adoptedFrom === undefined && (
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => setActing({ kind: 'publish' })}
            >
              发布
            </button>
          )}
          {held && (
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => setActing({ kind: 'challenge' })}
            >
              提出质疑
            </button>
          )}
          {held && !props.simulated && (
            <button type="button" className="link" disabled={busy} onClick={askModel}>
              让模型质疑
            </button>
          )}
          {held && others.length > 0 && (
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => setActing({ kind: 'contradict' })}
            >
              和另一条矛盾
            </button>
          )}
          {node.conflict && (
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() =>
                act(() => api.record(node.nodeId, { conflict: 'resolved' }, '你认为矛盾已解决'))
              }
            >
              矛盾已解决
            </button>
          )}
          {node.revisedTo === undefined && (
            <button
              type="button"
              className="link link-danger"
              disabled={busy}
              onClick={() =>
                act(() =>
                  node.withdrawn
                    ? api.record(node.nodeId, { stance: 'held' }, '你恢复了这条理解')
                    : api.record(node.nodeId, { stance: 'withdrawn' }, '你撤回了这条理解'),
                )
              }
            >
              {node.withdrawn ? '恢复' : '撤回'}
            </button>
          )}
        </p>
      )}

      {node.relations.length > 0 && (
        <section>
          <h4>关系</h4>
          <ul className="relations">
            {node.relations.map((relation) => (
              <li key={`${relation.type}-${relation.direction}-${relation.nodeId}`}>
                <span className="hint">{relationWord(relation.type, relation.direction)}</span>{' '}
                {understanding.nodes.some((other) => other.nodeId === relation.nodeId) ? (
                  <button
                    type="button"
                    className="link"
                    onClick={() => props.onSelect(relation.nodeId)}
                  >
                    {relation.label}
                  </button>
                ) : (
                  relation.label
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {node.elsewhere.length > 0 && (
        <section>
          <h4>和别人成果的关系</h4>
          <ul className="relations">
            {node.elsewhere.map((relation) => (
              <li key={`${relation.type}-${relation.direction}-${relation.nodeId}`}>
                <span className="hint">{elsewhereWord(relation.type, relation.direction)}</span>{' '}
                {relation.label}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(node.adoptedFrom !== undefined || isAnswer(node)) &&
        (showLineage ? (
          <Lineage node={node.nodeId} onClose={() => setShowLineage(false)} />
        ) : (
          <p>
            <button type="button" className="link" onClick={() => setShowLineage(true)}>
              看谱系和差异
            </button>
          </p>
        ))}

      {held && dimensions.length > 0 && (
        <section>
          <h4>我的状态</h4>
          <p className="hint">只有你能记录这些。确认一条理解，不等于你已经掌握它。</p>
          <div className="states">
            {dimensions.map((dimension) => (
              <StateChoice
                key={dimension.id}
                dimension={dimension}
                value={node.understanding.find((entry) => entry.id === dimension.id)?.level}
                disabled={busy}
                onChange={(level) =>
                  act(() => api.record(node.nodeId, { [dimension.id]: level }, '你自己记录'))
                }
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <h4>经过</h4>
        <ol className="trail">
          {trail.map((entry, index) => (
            // A trail only grows, and it is reread whole, so a position is stable for one reading.
            // biome-ignore lint: index is the identity here
            <li key={index}>
              <time className="hint">{whenOf(entry.at)}</time>
              <TrailLine
                entry={entry}
                dimensions={understanding.dimensions}
                onSelect={props.onSelect}
                onJump={props.onJump}
              />
            </li>
          ))}
        </ol>
      </section>
    </article>
  )
}

/** Whether this node answers someone else's: it points at something outside what the person wrote. */
const isAnswer = (node: HeldNode): boolean =>
  [...node.relations, ...node.elsewhere].some(
    (relation) => relation.type === 'forks_from' && relation.direction === 'out',
  ) || node.elsewhere.some((relation) => relation.direction === 'out')

function elsewhereWord(type: string, direction: 'in' | 'out'): string {
  if (type === 'forks_from') return direction === 'out' ? '这是你对它的版本：' : '有人由此分叉：'
  if (type === 'contradicts') return direction === 'out' ? '这一条反驳：' : '有人反驳它：'
  if (type === 'supports') return direction === 'out' ? '这一条支持：' : '有人支持它：'
  return `${type}：`
}

function relationWord(type: string, direction: 'in' | 'out'): string {
  if (type === 'forks_from') return direction === 'out' ? '这是你的版本，原文是' : '你的版本是'
  if (type === 'evolves_to') return direction === 'out' ? '修正为' : '由这条修正而来'
  if (type === 'supports') return direction === 'out' ? '支持' : '得到它的支持'
  return RELATION_WORDS[type] ?? type
}

function StateChoice(props: {
  dimension: Dimension
  value: string | undefined
  disabled: boolean
  onChange: (level: string) => void
}) {
  const { dimension, value } = props
  return (
    <label>
      {dimension.labelZh}
      <select
        value={value ?? ''}
        disabled={props.disabled}
        onChange={(event) => {
          if (event.target.value !== '') props.onChange(event.target.value)
        }}
      >
        {value === undefined && <option value="">还没记录</option>}
        {dimension.levelLabelsZh.map(({ level, label }) => (
          <option key={level} value={level}>
            {label}
          </option>
        ))}
      </select>
    </label>
  )
}

function TrailLine(props: {
  entry: TrailEntry
  dimensions: readonly Dimension[]
  onSelect: (node: string) => void
  onJump: (thread: string, turn: string | undefined) => void
}) {
  const { entry } = props
  const links = useContext(Links)
  switch (entry.kind) {
    case 'proposed':
      return (
        <p>
          {proposedWords(entry.speaker, entry.basis, entry.wordsBy)}
          {entry.thread !== undefined && (
            <>
              {' '}
              <button
                type="button"
                className="link"
                onClick={() => props.onJump(entry.thread ?? '', entry.turn)}
              >
                看原话
              </button>
            </>
          )}
        </p>
      )
    case 'revised_from':
      return (
        <p>
          由{' '}
          <button type="button" className="link" onClick={() => props.onSelect(entry.node)}>
            {entry.label}
          </button>{' '}
          修正而来。{entry.reason}
        </p>
      )
    case 'revised_to':
      return (
        <p>
          修正为{' '}
          <button type="button" className="link" onClick={() => props.onSelect(entry.node)}>
            {entry.label}
          </button>
          。{entry.reason}
        </p>
      )
    case 'state': {
      const dimension = props.dimensions.find((candidate) => candidate.id === entry.dimension)
      const level =
        dimension?.levelLabelsZh.find((candidate) => candidate.level === entry.level)?.label ??
        entry.level
      return (
        <p>
          {dimension?.labelZh ?? entry.dimension}：{level}。{entry.reason}
        </p>
      )
    }
    case 'challenged':
      return <ChallengeLine challenge={entry.challenge} onSelect={props.onSelect} />
    case 'adopted':
      return <p>你引用了 {links.nameOf(entry.author)} 发布的这一条。</p>
    case 'forked_from':
      return (
        <p>
          这是你对 {entry.author === undefined ? '别人' : links.nameOf(entry.author)} 的“
          {entry.label}”提出的版本。{entry.reason}
        </p>
      )
    case 'forked_to':
      return (
        <p>
          {entry.author === undefined ? '有人' : links.nameOf(entry.author)}由此分叉：{entry.label}
          。{entry.reason}
        </p>
      )
  }
}

function ChallengeLine(props: { challenge: Challenge; onSelect: (node: string) => void }) {
  const { challenge } = props
  const settled =
    challenge.status === 'open'
      ? '还没回应。'
      : challenge.status === 'dismissed'
        ? '你放下了它。'
        : challenge.status === 'conflict'
          ? '你记为未解决的矛盾。'
          : '你据此修正了这一条。'
  return (
    <p>
      {byWhom(challenge.by)}质疑：{challenge.text} {settled}
      {challenge.reason}
    </p>
  )
}

function Revising(props: {
  initial: string
  busy: boolean
  adopted: boolean
  onCancel: () => void
  onSave: (label: string, reason: string) => void
}) {
  const [label, setLabel] = useState(props.initial)
  const [reason, setReason] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    props.onSave(label.trim(), reason.trim())
  }
  return (
    <form className="acting" onSubmit={submit}>
      <label>
        现在你怎么想
        <textarea rows={3} value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <label>
        为什么改（可不填）
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <p className="hint">
        {props.adopted
          ? '原作者的内容不会改变。你的版本先只有你能看到，发布后别人才看得到。'
          : '原来那条和它的经过都会留下。'}
      </p>
      <p className="decisions">
        <button
          type="submit"
          disabled={props.busy || label.trim() === '' || label.trim() === props.initial}
        >
          {props.adopted ? '保存我的版本' : '保存修正'}
        </button>
        <button type="button" className="link" onClick={props.onCancel}>
          取消
        </button>
      </p>
    </form>
  )
}

function OneLine(props: {
  label: string
  placeholder: string
  action: string
  busy: boolean
  onCancel: () => void
  onSave: (text: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <form
      className="acting"
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave(value.trim())
      }}
    >
      <label>
        {props.label}
        <textarea
          rows={2}
          placeholder={props.placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <p className="decisions">
        <button type="submit" disabled={props.busy || value.trim() === ''}>
          {props.action}
        </button>
        <button type="button" className="link" onClick={props.onCancel}>
          取消
        </button>
      </p>
    </form>
  )
}

function Contradicting(props: {
  others: readonly HeldNode[]
  busy: boolean
  onCancel: () => void
  onSave: (other: string) => void
}) {
  const [other, setOther] = useState(props.others[0]?.nodeId ?? '')
  return (
    <form
      className="acting"
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave(other)
      }}
    >
      <label>
        和哪一条矛盾
        <select value={other} onChange={(event) => setOther(event.target.value)}>
          {props.others.map((candidate) => (
            <option key={candidate.nodeId} value={candidate.nodeId}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">两条都会留下，等你想通，不必现在选一条。</p>
      <p className="decisions">
        <button type="submit" disabled={props.busy}>
          记下这个矛盾
        </button>
        <button type="button" className="link" onClick={props.onCancel}>
          取消
        </button>
      </p>
    </form>
  )
}
