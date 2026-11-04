import { useEffect, useState } from 'react'
import {
  api,
  type BlockInfo,
  type ObjectiveReading,
  type SessionEvent,
  type SessionOutcome,
} from './api.js'
import { messageOf } from './Turns.js'

/**
 * What came of learning with an agent, by session. The conversation itself stays out unless it is asked for, and what
 * an agent judged is never shown as what the person confirmed.
 */

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

function Event(props: { event: SessionEvent; blocks: readonly BlockInfo[] }) {
  const { event, blocks } = props
  const { assessment, move, candidate } = event
  if (event.kind === 'attempt') {
    return (
      <>
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
  if (event.kind === 'statement') return <>你说了自己的想法，原话在对话里。</>
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
  focus: string | undefined
  version: number
  blocks: readonly BlockInfo[]
  onReview: () => void
  onOpenThread: (thread: string) => void
}) {
  const { space, version } = props
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
  const waiting = outcomes.objectives.some((each) => each.confirmation === 'pending')
  const { unlinked } = outcomes
  return (
    <div className="page outcomes">
      <h2 className="space-title">{props.name}</h2>
      <section>
        <h3>现在的情况</h3>
        <p className="hint">答题记录和你的确认分开看。两者都不代表已经掌握。</p>
        {outcomes.objectives.map((objective) => (
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
        {(waiting || unlinked > 0) && (
          <p>
            <button type="button" className="link" onClick={props.onReview}>
              去确认
            </button>
          </p>
        )}
      </section>
      {outcomes.sessions.map((session) => (
        <Session
          key={session.plan}
          session={session}
          focused={session.plan === props.focus}
          blocks={props.blocks}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </div>
  )
}
