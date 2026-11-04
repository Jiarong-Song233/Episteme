import { useState } from 'react'
import type { Answer, Citation, Evidence, Turn } from './api.js'

/** What the agent said, shared by a conversation and a plan. */

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : '出了点问题。请重试。'

export function AgentTurn(props: {
  turn: Turn
  onCite: (citation: Citation, evidence?: Evidence) => void
  onCandidates: (reply: string) => Promise<string | undefined>
}) {
  const { turn } = props
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle')
  const [note, setNote] = useState<string>()
  if (turn.answer === undefined) return <p className="answer">{turn.text}</p>
  const usable = turn.answer.segments.some(
    (segment) => segment.basis === 'material' && segment.weak !== true,
  )
  return (
    <article className="answer-block">
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
