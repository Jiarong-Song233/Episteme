import { useEffect, useState } from 'react'
import {
  api,
  type BlockInfo,
  type ObjectiveReading,
  type PendingCandidate,
  type SessionEvent,
  type SessionOutcome,
} from './api.js'
import { StatusView } from './Learning.js'
import { messageOf } from './Turns.js'

/**
 * A space's overview: what waits for the person, where the gaps are, and what came of learning, by session. The
 * conversation itself stays out unless it is asked for, and what an agent judged is never shown as what the person
 * confirmed.
 */

/** Enough to see what is waiting; the whole list and the decisions stay in the review column. */
const PENDING_SHOWN = 3

const VERDICT: Readonly<Record<string, string>> = {
  supports: '答对',
  partial: '部分对',
  contradicts: '不对',
  unclear: '说不准',
}

const JUDGED_BY: Readonly<Record<string, string>> = {
  agent: 'Agent 判断',
  model: '模型估计',
  mechanical: '程序判定',
}

const CONFIRMATION: Readonly<Record<ObjectiveReading['confirmation'], string>> = {
  none: '你还没有确认过',
  pending: '有一条等你确认',
  delegated: '按你的委托规则接受，不是你亲自确认的',
  person: '你确认过',
}

const AGENT_ACTOR = 'actor_agent_'

const CANDIDATE: Readonly<Record<string, string>> = {
  pending: '等你确认',
  person: '你确认了',
  delegated: '按委托规则接受',
  dropped: '没有留下',
}

/** A skipped step was not done, so "4 / 4" would overstate a session that skipped three. */
function stepWords(steps: SessionOutcome['steps']): string {
  const left = steps.total - steps.done - steps.skipped
  return [
    `${steps.done} 步做完`,
    ...(steps.skipped > 0 ? [`${steps.skipped} 步跳过`] : []),
    ...(left > 0 ? [`还剩 ${left} 步`] : []),
  ].join('，')
}

function recorderWords(actor: string): string {
  return actor.startsWith(AGENT_ACTOR) ? `Agent（${actor.slice(AGENT_ACTOR.length)}）` : actor
}

function evidenceWords(objective: ObjectiveReading): string {
  const { gap, attempts } = objective
  if (attempts === 0) return '还没有答题记录'
  if (gap === undefined) return `答过 ${attempts} 次，没有发现缺口`
  const diagnosis = gap.diagnosis === undefined ? '' : `：${gap.diagnosis}`
  if (gap.status === 'open') return `还有缺口${diagnosis}`
  if (gap.status === 'retried') return `缺口之后又试过 ${gap.retries} 次，还没有判断${diagnosis}`
  return `缺口之后的回答被判断为答对（${JUDGED_BY[gap.supportedBy?.method ?? 'agent']}）。这不等于已经掌握`
}

/** Only for words that rest on a turn; what the person answered on the page itself has none. */
const ANSWER_SOURCE: Readonly<Record<string, string>> = {
  agent: '回答由 Agent 转述。',
  unrecorded: '回答的来源未记录。',
}

const STATEMENT: Readonly<Record<string, string>> = {
  person: '你说了自己的想法，原话在对话里。',
  agent: 'Agent 转述了你的想法，原话在对话里。',
  unrecorded: '记下了一段你的想法，来源未记录，原话在对话里。',
}

function Event(props: { event: SessionEvent; blocks: readonly BlockInfo[] }) {
  const { event, blocks } = props
  const { assessment, move, candidate } = event
  if (event.kind === 'attempt') {
    const source = ANSWER_SOURCE[event.wordsBy ?? '']
    return (
      <>
        {source !== undefined && <span className="hint">{source} </span>}
        {assessment === undefined ? (
          '答了一次，没有判断。'
        ) : (
          <>
            <b>{VERDICT[assessment.verdict]}</b>（{JUDGED_BY[assessment.method]}）：
            {assessment.reason.replace(/[。.\s]+$/u, '')}
            {assessment.diagnosis !== undefined && `。缺口：${assessment.diagnosis}`}
          </>
        )}
      </>
    )
  }
  if (event.kind === 'statement') return <>{STATEMENT[event.wordsBy ?? 'unrecorded']}</>
  if (event.kind === 'feedback') return <>反馈：{assessment?.reason}</>
  if (move !== undefined) {
    const title = blocks.find((block) => block.id === move.activity)?.title ?? move.activity
    return (
      <>
        Agent 选了“{title}”：{move.reason}
      </>
    )
  }
  return (
    <>
      提出一条理解：{candidate?.label}（{CANDIDATE[candidate?.status ?? 'dropped']}）
    </>
  )
}

function Session(props: {
  session: SessionOutcome
  focused: boolean
  blocks: readonly BlockInfo[]
  onOpenThread: (thread: string) => void
}) {
  const { session, blocks } = props
  const { steps } = session
  return (
    <section className="outcome-session" data-focused={props.focused}>
      <h3>{session.topic}</h3>
      <p className="hint">
        {new Date(session.startedAt).toLocaleDateString('zh-CN')}开始，{stepWords(steps)}
        {session.recordedBy.length > 0 &&
          `，由 ${session.recordedBy.map(recorderWords).join('、')} 记录`}
        。{' '}
        <button type="button" className="link" onClick={() => props.onOpenThread(session.thread)}>
          看原始对话
        </button>
      </p>
      {session.objectives.map((objective) => (
        <div key={objective.id}>
          <h4>{objective.label}</h4>
          {objective.events.length === 0 ? (
            <p className="hint">这次没有留下记录。</p>
          ) : (
            <ul>
              {objective.events.map((event) => (
                <li key={event.id} data-kind={event.kind} data-verdict={event.assessment?.verdict}>
                  <Event event={event} blocks={blocks} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  )
}

export function Outcomes(props: {
  space: string
  name: string
  /** The session a person came to read. Without one, this is the overview and the latest session leads. */
  focus: string | undefined
  version: number
  blocks: readonly BlockInfo[]
  pending: readonly PendingCandidate[]
  /** Where the person left off, when there is somewhere to go back to. */
  resume: { readonly label: string; readonly open: () => void } | undefined
  onNewThread: () => void
  onReview: () => void
  onOpenThread: (thread: string) => void
}) {
  const { space, version, pending, focus, resume } = props
  const [outcomes, setOutcomes] = useState<Awaited<ReturnType<typeof api.outcomes>>>()
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    let current = true
    api
      .outcomes(space)
      .then((reply) => {
        if (current) {
          setOutcomes(reply)
          setFailure(undefined)
        }
      })
      .catch((error: unknown) => {
        if (current) setFailure(messageOf(error))
      })
    return () => {
      current = false
    }
  }, [space, version])

  if (failure !== undefined) {
    return (
      <p className="banner banner-error" role="alert">
        {failure}
      </p>
    )
  }
  if (outcomes === undefined) return null
  const { unlinked, objectives } = outcomes
  const sessions = [...outcomes.sessions].sort((a, b) => b.startedAt - a.startedAt)
  const leading = focus === undefined ? sessions.slice(0, 1) : sessions
  const earlier = focus === undefined ? sessions.slice(1) : []
  const show = (session: SessionOutcome) => (
    <Session
      key={session.plan}
      session={session}
      focused={session.plan === focus}
      blocks={props.blocks}
      onOpenThread={props.onOpenThread}
    />
  )
  return (
    <div className="page outcomes">
      <h2 className="space-title">{props.name}</h2>
      <section>
        <h3>等你确认（{pending.length}）</h3>
        {pending.length === 0 ? (
          <p className="hint">现在没有等你确认的内容。</p>
        ) : (
          <>
            <ul>
              {pending.slice(0, PENDING_SHOWN).map((candidate) => (
                <li key={candidate.id}>
                  {candidate.link === undefined
                    ? (candidate.proposal.label ?? candidate.rationale)
                    : `${candidate.link.fromLabel} 和 ${candidate.link.toLabel} 的关系`}
                </li>
              ))}
            </ul>
            {pending.length > PENDING_SHOWN && (
              <p className="hint">还有 {pending.length - PENDING_SHOWN} 条。</p>
            )}
            <p className="next-action">
              <button type="button" onClick={props.onReview}>
                去确认
              </button>
            </p>
          </>
        )}
      </section>
      {objectives.length > 0 && (
        <section>
          <h3>现在的情况</h3>
          <p className="hint">答题记录和你的确认分开看。两者都不代表已经掌握。</p>
          {objectives.map((objective) => (
            <div className="reading" key={objective.id} data-gap={objective.gap?.status}>
              <strong>{objective.label}</strong>
              <span>{evidenceWords(objective)}</span>
              <span className="hint">{CONFIRMATION[objective.confirmation]}</span>
            </div>
          ))}
          {unlinked > 0 && (
            <p className="hint">
              另有 {unlinked} 条候选没有关联到上面的学习目标。确认后会成为你的理解，但不会计入这里。
            </p>
          )}
        </section>
      )}
      {focus === undefined && (
        <section>
          <h3>接着学</h3>
          <p className="next-action">
            {resume !== undefined && (
              <button type="button" onClick={resume.open}>
                回到“{resume.label}”
              </button>
            )}
            <button type="button" className="link" onClick={props.onNewThread}>
              问一个新问题
            </button>
          </p>
        </section>
      )}
      {leading.map(show)}
      {earlier.length > 0 && (
        <details>
          <summary>更早的 {earlier.length} 次学习</summary>
          {earlier.map(show)}
        </details>
      )}
      {focus === undefined && (
        <section>
          <h3>练习和复习</h3>
          <StatusView space={space} version={version} />
        </section>
      )}
    </div>
  )
}
