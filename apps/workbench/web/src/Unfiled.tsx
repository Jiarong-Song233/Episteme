import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, type Space, type UnfiledCandidate } from './api.js'
import { wordsOf } from './Understanding.js'

/**
 * What waits for the person but was proposed outside any space, such as by an agent that named none. Nothing files
 * it anywhere on its own: the person confirms it as it is, confirms it into a space they pick here, or turns it down.
 */

function proposerOf(actor: string, nameOf: (actor: string) => string): string {
  if (actor.startsWith('actor_agent_')) return `Agent ${actor.slice('actor_agent_'.length)}`
  return nameOf(actor)
}

function when(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString('zh-CN')
}

const KIND_NAMES: Readonly<Record<string, string>> = {
  node: '理解',
  claim: '论断',
  link: '关系',
  state: '状态',
}

function UnfiledItem(props: {
  candidate: UnfiledCandidate
  nameOf: (actor: string) => string
  spaces: readonly Space[]
  guard: (work: () => Promise<unknown>) => void
  onDecided: () => Promise<void>
}) {
  const { candidate, guard, onDecided } = props
  const [space, setSpace] = useState('')
  const decide = (work: () => Promise<unknown>): void => {
    guard(async () => {
      await work()
      await onDecided()
    })
  }
  const label =
    candidate.proposal.label ?? `${KIND_NAMES[candidate.proposal.kind] ?? candidate.proposal.kind}`
  const open = props.spaces.filter((each) => !each.archived)
  return (
    <li>
      <p className="candidate">{label}</p>
      <p className="hint">
        {wordsOf(candidate.basis, candidate.wordsBy)}。{candidate.rationale}
      </p>
      {candidate.held === true && (
        <p className="hint">你已经有一条一模一样的理解。不需要的话可以点“不要”。</p>
      )}
      <dl className="unfiled-facts">
        <dt>提出者</dt>
        <dd>{proposerOf(candidate.proposedBy, props.nameOf)}</dd>
        <dt>归属</dt>
        <dd>{props.nameOf(candidate.owner)}</dd>
        <dt>提出时间</dt>
        <dd>{when(candidate.proposedAt)}</dd>
        <dt>空间</dt>
        <dd>未指定</dd>
      </dl>
      <p className="decisions">
        {candidate.fileable && (
          <label className="unfiled-space">
            <span className="hint">归入空间</span>
            <select
              aria-label={`为“${label}”选择空间`}
              value={space}
              onChange={(event) => setSpace(event.target.value)}
            >
              <option value="">不归入任何空间</option>
              {open.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() =>
            decide(() =>
              space === '' ? api.accept(candidate.id) : api.acceptInto(candidate.id, space),
            )
          }
        >
          {space === '' ? '确认为我的理解' : '确认并归入这个空间'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => decide(() => api.dismiss(candidate.id))}
        >
          不要
        </button>
      </p>
    </li>
  )
}

export function UnfiledPage(props: {
  nameOf: (actor: string) => string
  spaces: readonly Space[]
  guard: (work: () => Promise<unknown>) => void
  onChanged: (count: number) => void
  /** After a decision: what was confirmed may now sit in the space the rest of the page holds. */
  onDecided: () => Promise<void>
}) {
  const { onChanged, onDecided } = props
  const [pending, setPending] = useState<readonly UnfiledCandidate[]>()
  const [problem, setProblem] = useState<string>()

  const load = useCallback(async () => {
    try {
      const reply = await api.unfiled()
      setPending(reply.pending)
      setProblem(undefined)
      onChanged(reply.pending.length)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : '读不到未分类的待确认内容。')
    }
  }, [onChanged])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="page connect">
      <h2 className="space-title">未分类待确认</h2>
      <p className="hint page-hint">
        这些候选在提出时没有指定空间，比如 Agent
        没说是哪个空间。它们不会被自动放进任何空间：你可以原样确认，确认时选一个空间归入，或者不要。只有你能决定，Agent
        不能替你确认。
      </p>
      {problem !== undefined && (
        <p className="banner banner-error" role="status">
          {problem}
        </p>
      )}
      <section className="panel">
        {pending === undefined ? (
          <p className="hint">正在读取……</p>
        ) : pending.length === 0 ? (
          <p className="hint">没有未分类的待确认内容。</p>
        ) : (
          <ul className="pending">
            {pending.map((candidate) => (
              <UnfiledItem
                key={candidate.id}
                candidate={candidate}
                nameOf={props.nameOf}
                spaces={props.spaces}
                guard={props.guard}
                onDecided={async () => {
                  await load()
                  await onDecided()
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
