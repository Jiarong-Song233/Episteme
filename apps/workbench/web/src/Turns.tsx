import { createContext, useContext, useState } from 'react'
import type { Answer, Citation, Evidence, HeldNode, Turn } from './api.js'

/** What the agent said, shared by a conversation and a plan. */

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : '出了点问题。请重试。'

/** What a turn needs to reach the understanding drawn from it, and to go the other way. */
export interface TurnLinks {
  readonly nodes: readonly HeldNode[]
  /** The turn a node's page sent the person back to. */
  readonly focused: string | undefined
  readonly openNode: (node: string) => void
  /** What to call whoever wrote something. */
  readonly nameOf: (actor: string) => string
  readonly refreshNames: () => Promise<void>
  readonly openPublication: (publication: string) => void
  /** Whether this service allows publishing at all. */
  readonly sharing: boolean
  readonly offer: (thread: string, turn: string) => Promise<string | undefined>
}

export const Links = createContext<TurnLinks>({
  nodes: [],
  focused: undefined,
  openNode: () => undefined,
  nameOf: () => '另一位用户',
  refreshNames: () => Promise.resolve(),
  openPublication: () => undefined,
  sharing: false,
  offer: () => Promise.resolve(undefined),
})

/** What the person said, which they can make their own, or see what it became. */
export function LearnerTurn({ turn, thread }: { turn: Turn; thread: string | undefined }) {
  const links = useContext(Links)
  const [note, setNote] = useState<string>()
  const [working, setWorking] = useState(false)
  const made = links.nodes.find((node) => node.origin?.turn === turn.id)
  // A turn still being sent has no id to go back to yet.
  const canOffer = thread !== undefined && turn.id !== 'asking'
  return (
    <div id={`turn-${turn.id}`} className="learner-turn" data-focused={links.focused === turn.id}>
      <p className="question">{turn.text}</p>
      {made !== undefined ? (
        <button type="button" className="link" onClick={() => links.openNode(made.nodeId)}>
          已记成理解，去看看
        </button>
      ) : (
        canOffer && (
          <button
            type="button"
            className="link own-words"
            disabled={working}
            onClick={() => {
              setWorking(true)
              setNote(undefined)
              links
                .offer(thread, turn.id)
                .then(setNote)
                .catch((error: unknown) => setNote(messageOf(error)))
                .finally(() => setWorking(false))
            }}
          >
            {working ? '正在记下…' : '这是我的理解'}
          </button>
        )
      )}
      {note !== undefined && made === undefined && <p className="hint">{note}</p>}
    </div>
  )
}

/** What the person had confirmed on this, set apart from the answer, because it is not evidence. */
function Recalled({ answer }: { answer: Answer }) {
  const links = useContext(Links)
  if (answer.recalled === undefined) return null
  return (
    <aside className="recalled">
      <p className="hint">你之前确认过（不是材料，只是提醒）：</p>
      <ul>
        {answer.recalled.map((item) => (
          <li key={item.nodeId}>
            <button type="button" className="link" onClick={() => links.openNode(item.nodeId)}>
              {item.label}
            </button>
            {item.conflict && <span className="hint">（你还有未解决的矛盾）</span>}
            {item.from !== undefined && (
              <span className="hint">
                （你引用的成果，作者：
                <button
                  type="button"
                  className="link"
                  onClick={() => links.openPublication(item.from?.publication ?? '')}
                >
                  {links.nameOf(item.from.author)}
                </button>
                ）
              </span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  )
}

export function AgentTurn(props: {
  turn: Turn
  onCite: (citation: Citation, evidence?: Evidence) => void
  onCandidates: (reply: string) => Promise<string | undefined>
}) {
  const { turn } = props
  const links = useContext(Links)
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle')
  const [note, setNote] = useState<string>()
  if (turn.answer === undefined) {
    return (
      <p id={`turn-${turn.id}`} className="answer" data-focused={links.focused === turn.id}>
        {turn.text}
      </p>
    )
  }
  const usable = turn.answer.segments.some(
    (segment) => segment.basis === 'material' && segment.weak !== true,
  )
  return (
    <article
      id={`turn-${turn.id}`}
      className="answer-block"
      data-focused={links.focused === turn.id}
    >
      <Recalled answer={turn.answer} />
      <AnswerBody answer={turn.answer} onCite={props.onCite} />
      {note !== undefined && <p className="hint">{note}</p>}
      {usable && (
        <button
          type="button"
          className="link"
          disabled={state !== 'idle'}
          onClick={() => {
            setState('working')
            props
              .onCandidates(turn.id)
              .then((message) => {
                setNote(message)
                setState('done')
              })
              .catch((error: unknown) => {
                setNote(messageOf(error))
                setState('idle')
              })
          }}
        >
          {state === 'working' ? '正在提炼…' : state === 'done' ? '已提炼' : '提炼成待确认的理解'}
        </button>
      )}
    </article>
  )
}

function AnswerBody({
  answer,
  onCite,
}: {
  answer: Answer
  onCite: (citation: Citation, evidence?: Evidence) => void
}) {
  if (answer.status === 'insufficient_evidence') {
    return (
      <p className="no-evidence">材料里没有足够的依据讲这一点。可以换个问法，或者上传相关材料。</p>
    )
  }
  const byNumber = new Map(answer.citations.map((citation) => [citation.n, citation]))
  return (
    <>
      {answer.status === 'inference_only' && (
        <p className="hint">这条回答没有一句能在材料里找到依据。下面全是模型的推断。</p>
      )}
      <p className="answer">
        {answer.segments.map((segment, index) => {
          const kind =
            segment.basis === 'question'
              ? 'asked'
              : segment.basis === 'inference'
                ? 'inferred'
                : segment.weak === true
                  ? 'weak'
                  : 'sourced'
          return (
            // Segments never move: an answer is stored once and only read after that.
            // biome-ignore lint: index is the identity here
            <span key={index} className={kind}>
              {kind === 'inferred' && <span className="visually-hidden">（模型推断）</span>}
              {kind === 'weak' && <span className="visually-hidden">（引用待核对）</span>}
              {segment.text}
              {segment.citations.map((n) => {
                const citation = byNumber.get(n)
                return citation === undefined ? null : (
                  <button
                    type="button"
                    key={n}
                    className="cite"
                    aria-label={`查看引用 ${n}：${citation.title}`}
                    onClick={() =>
                      onCite(
                        citation,
                        segment.evidence?.find((found) => found.n === n),
                      )
                    }
                  >
                    {n}
                  </button>
                )
              })}
            </span>
          )
        })}
      </p>
      {answer.invalidCitations.length > 0 && (
        <p className="hint">
          模型引用了不存在的片段（{answer.invalidCitations.join('、')}），相应的句子已按推断处理。
        </p>
      )}
      <p className="legend">
        {answer.citations.length > 0 && <span>角标：点开看原文</span>}
        {answer.segments.some((segment) => segment.basis === 'inference') && (
          <span>
            <span className="inferred">波浪线</span>：模型的推断，材料里没有
          </span>
        )}
        {answer.segments.some((segment) => segment.weak === true) && (
          <span>
            <span className="weak">虚线</span>：引用可能不对，请核对原文
          </span>
        )}
      </p>
    </>
  )
}
