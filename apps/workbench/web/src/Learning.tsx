import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  api,
  type BlockInfo,
  type Citation,
  type Evidence,
  type Failure,
  type Plan,
  type PlanDetail,
  type PlanProposal,
  type PublicQuestion,
  type Status,
  type Step,
  type Turn,
  type WorkflowInfo,
} from './api.js'
import { AgentTurn, messageOf, LearnerTurn } from './Turns.js'

/** Plans in the shelf, a plan on the page, and what the record says so far. */

const LOCKED: readonly Step['status'][] = ['done', 'active']

export function PlanShelf(props: {
  plans: readonly Plan[]
  current: string | undefined
  workflows: readonly WorkflowInfo[]
  hasMaterial: boolean
  archived: boolean
  guard: (work: () => Promise<unknown>) => void
  onCreate: (topic: string, minutes: number, workflow: string) => Promise<PlanProposal>
  onCreated: (plan: Plan, notice?: string) => void
  onSelect: (id: string) => void
}) {
  const { workflows } = props
  const [topic, setTopic] = useState('')
  const [minutes, setMinutes] = useState('60')
  const [workflow, setWorkflow] = useState('speedrun')
  const [creating, setCreating] = useState(false)
  const chosen = workflows.find((candidate) => candidate.id === workflow)

  const create = (event: FormEvent): void => {
    event.preventDefault()
    const wanted = topic.trim()
    if (wanted === '' || creating) return
    setCreating(true)
    props.guard(async () => {
      try {
        const { plan, notice } = await props.onCreate(wanted, Number(minutes), workflow)
        setTopic('')
        props.onCreated(plan, notice)
      } finally {
        setCreating(false)
      }
    })
  }

  return (
    <section>
      <h2>学习计划</h2>
      <ul className="list">
        {props.plans.map((plan) => (
          <li key={plan.id}>
            <button
              type="button"
              className="row"
              aria-current={plan.id === props.current}
              onClick={() => props.onSelect(plan.id)}
            >
              {plan.topic}
              {plan.origin === 'host' && '（Agent 带领）'}
              {plan.status === 'paused' && '（已暂停）'}
              {plan.status === 'done' && '（已结束）'}
            </button>
          </li>
        ))}
      </ul>
      {props.hasMaterial && !props.archived ? (
        <form className="plan-form" onSubmit={create}>
          <input
            aria-label="想学什么"
            placeholder="想学什么"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
          />
          <label className="minutes">
            可用时间
            <input
              type="number"
              min={5}
              max={600}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
            />
            分钟
          </label>
          <fieldset className="modes">
            <legend className="visually-hidden">学习方式</legend>
            {workflows.map((candidate) => (
              <label key={candidate.id}>
                <input
                  type="radio"
                  name="workflow"
                  checked={candidate.id === workflow}
                  onChange={() => setWorkflow(candidate.id)}
                />
                {candidate.title}
              </label>
            ))}
          </fieldset>
          {chosen !== undefined && <p className="hint">{chosen.description}</p>}
          <button type="submit" disabled={creating || topic.trim() === ''}>
            {creating ? '正在拟计划…' : '生成计划'}
          </button>
        </form>
      ) : (
        <p className="hint">上传材料后，可以生成学习计划。</p>
      )}
    </section>
  )
}

interface Sent {
  readonly action: string
  readonly text?: string
}

export function PlanView(props: {
  plan: string
  blocks: readonly BlockInfo[]
  workflows: readonly WorkflowInfo[]
  notice: string | undefined
  guard: (work: () => Promise<unknown>) => void
  onChanged: () => void
  onCite: (citation: Citation, evidence?: Evidence) => void
  onCandidates: (thread: string, reply: string) => Promise<string | undefined>
  onShowOverview: () => void
}) {
  const { guard, onChanged } = props
  const [detail, setDetail] = useState<PlanDetail>()
  const [working, setWorking] = useState(false)
  const [failed, setFailed] = useState<{ sent: Sent; failure: Failure }>()
  const [editing, setEditing] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDetail(undefined)
    setFailed(undefined)
    setEditing(false)
    guard(async () => setDetail(await api.plan(props.plan)))
  }, [props.plan, guard])

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [detail?.turns.length, working, failed])

  if (detail === undefined) {
    return (
      <p className="working empty" role="status">
        正在打开计划…
      </p>
    )
  }
  const { plan, turns, question } = detail
  const titleOf = (id: string): string => props.blocks.find((block) => block.id === id)?.title ?? id
  const started = plan.steps.some((step) => step.status !== 'pending' && step.status !== 'skipped')
  const step = plan.steps.find((candidate) => candidate.status === 'active')
  const block = props.blocks.find((candidate) => candidate.id === step?.block)
  const workflow = props.workflows.find((candidate) => candidate.id === plan.workflow)

  const reload = async (): Promise<void> => {
    setDetail(await api.plan(plan.id))
    onChanged()
  }

  const send = (sent: Sent, retry = false): void => {
    setWorking(true)
    setFailed(undefined)
    if (sent.text !== undefined && !retry && sent.action === 'reply') {
      setDetail((held) =>
        held === undefined
          ? held
          : {
              ...held,
              turns: [...held.turns, { id: 'saying', speaker: 'learner', text: sent.text ?? '' }],
            },
      )
    }
    guard(async () => {
      try {
        const reply = await api.act(plan.id, sent.action, sent.text, retry)
        if (reply.failure !== undefined) setFailed({ sent, failure: reply.failure })
        await reload()
      } finally {
        setWorking(false)
      }
    })
  }

  const setPaused = (paused: boolean): void => {
    guard(async () => {
      await api.updatePlan(plan.id, { status: paused ? 'paused' : 'active' })
      await reload()
    })
  }

  return (
    <>
      <div className="page">
        <h2 className="space-title">{plan.topic}</h2>
        <p className="plan-meta">
          {workflow?.title ?? plan.workflow}，计划 {plan.minutes} 分钟。
          {plan.origin === 'outline' && '重点按材料目录生成。'}
          {plan.status !== 'done' && (
            <button
              type="button"
              className="link"
              onClick={() => setPaused(plan.status !== 'paused')}
            >
              {plan.status === 'paused' ? '继续学习' : '暂停'}
            </button>
          )}
        </p>
        {props.notice !== undefined && <p className="hint">{props.notice}</p>}
        {editing ? (
          <PlanEditor
            plan={plan}
            blocks={props.blocks}
            onCancel={() => setEditing(false)}
            onSave={(steps) =>
              guard(async () => {
                await api.updatePlan(plan.id, { steps })
                setEditing(false)
                await reload()
              })
            }
          />
        ) : (
          <details className="plan-steps" open={!started}>
            <summary>
              计划（{plan.steps.filter((candidate) => candidate.status === 'done').length} /{' '}
              {plan.steps.length}）
            </summary>
            <ol>
              {plan.steps.map((candidate) => (
                <li key={candidate.id} data-status={candidate.status}>
                  <span>
                    {titleOf(candidate.block)}：{candidate.focus}
                  </span>
                  <span className="hint">
                    {candidate.status === 'skipped'
                      ? (candidate.note ?? '跳过')
                      : `${candidate.minutes} 分钟`}
                  </span>
                </li>
              ))}
            </ol>
            {plan.status !== 'done' && (
              <button type="button" className="link" onClick={() => setEditing(true)}>
                修改计划
              </button>
            )}
          </details>
        )}
        {turns.map((turn: Turn) =>
          turn.speaker === 'learner' ? (
            <LearnerTurn key={turn.id} turn={turn} thread={plan.thread} />
          ) : (
            <AgentTurn
              key={turn.id}
              turn={turn}
              onCite={props.onCite}
              onCandidates={(reply) => props.onCandidates(plan.thread, reply)}
            />
          ),
        )}
        {working && (
          <p className="working" role="status">
            正在准备…
          </p>
        )}
        {failed !== undefined && (
          <div className="failed" role="alert">
            <p>{failed.failure.message}进度已保留。</p>
            {failed.failure.retryable && (
              <button type="button" onClick={() => send(failed.sent, true)}>
                重试
              </button>
            )}
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="composer plan-controls">
        {plan.status === 'done' ? (
          <p>
            这个计划结束了。
            <button type="button" className="link" onClick={props.onShowOverview}>
              看这个空间的概览
            </button>
          </p>
        ) : plan.status === 'paused' ? (
          <p>已暂停。进度都保存着。</p>
        ) : step === undefined ? (
          <button type="button" disabled={working} onClick={() => send({ action: 'begin' })}>
            {started ? '继续' : '开始学习'}
          </button>
        ) : !step.entered ? (
          <>
            <span className="step-title">{titleOf(step.block)}还没打开。</span>
            <button type="button" disabled={working} onClick={() => send({ action: 'begin' })}>
              重新打开这一步
            </button>
            <button
              type="button"
              className="link"
              disabled={working}
              onClick={() => send({ action: 'skip' })}
            >
              跳过这一步
            </button>
          </>
        ) : question !== undefined ? (
          <QuestionForm
            key={question.prompt}
            question={question}
            working={working}
            onAnswer={(text) => send({ action: 'answer', text })}
            onSkip={() => send({ action: 'next' })}
          />
        ) : block?.interaction === 'dialog' ? (
          <DialogControls
            step={step}
            block={block}
            working={working}
            onReply={(text) => send({ action: 'reply', text })}
            onDirect={() => send({ action: 'direct' })}
            onNext={() => send({ action: 'next' })}
          />
        ) : (
          <button type="button" disabled={working} onClick={() => send({ action: 'next' })}>
            下一步
          </button>
        )}
      </div>
    </>
  )
}

function DialogControls(props: {
  step: Step
  block: BlockInfo
  working: boolean
  onReply: (text: string) => void
  onDirect: () => void
  onNext: () => void
}) {
  const [draft, setDraft] = useState('')
  const enough = props.step.rounds >= (props.block.maxRounds ?? 1)
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    const text = draft.trim()
    if (text === '' || props.working) return
    setDraft('')
    props.onReply(text)
  }
  return (
    <form className="control-form" onSubmit={submit}>
      {enough && <p className="hint">这一步聊得差不多了，可以往下走；想接着说也行。</p>}
      <textarea
        aria-label="你的想法"
        placeholder="用你自己的话说"
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <p className="decisions">
        <button type="submit" disabled={props.working || draft.trim() === ''}>
          回复
        </button>
        <button type="button" className="link" disabled={props.working} onClick={props.onDirect}>
          直接讲给我听
        </button>
        <button type="button" className="link" disabled={props.working} onClick={props.onNext}>
          这一步够了
        </button>
      </p>
    </form>
  )
}

function QuestionForm(props: {
  question: PublicQuestion
  working: boolean
  onAnswer: (text: string) => void
  onSkip: () => void
}) {
  const { question } = props
  const [draft, setDraft] = useState('')
  return (
    <form
      className="control-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (draft.trim() !== '' && !props.working) props.onAnswer(draft.trim())
      }}
    >
      <p className="exercise">{question.prompt}</p>
      {question.options !== undefined ? (
        <fieldset className="options">
          <legend className="visually-hidden">选项</legend>
          {question.options.map((option, index) => (
            // Options never move: a question is stored once.
            // biome-ignore lint: index is the identity here
            <label key={index}>
              <input
                type="radio"
                name="option"
                checked={draft === String(index)}
                onChange={() => setDraft(String(index))}
              />
              {option}
            </label>
          ))}
        </fieldset>
      ) : (
        <textarea
          aria-label="你的答案"
          rows={question.kind === 'short' ? 3 : 1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      <p className="decisions">
        <button type="submit" disabled={props.working || draft.trim() === ''}>
          提交答案
        </button>
        <button type="button" className="link" disabled={props.working} onClick={props.onSkip}>
          不答了，往下走
        </button>
      </p>
    </form>
  )
}

interface DraftStep {
  readonly id?: string
  readonly key: string
  readonly block: string
  readonly focus: string
  readonly minutes: number
  readonly status: Step['status']
  readonly note?: string
  readonly restore?: boolean
}

function PlanEditor(props: {
  plan: Plan
  blocks: readonly BlockInfo[]
  onCancel: () => void
  onSave: (steps: readonly unknown[]) => void
}) {
  const [steps, setSteps] = useState<readonly DraftStep[]>(() =>
    props.plan.steps.map((step) => ({ ...step, key: step.id })),
  )
  const [added, setAdded] = useState(0)
  const titleOf = (id: string): string => props.blocks.find((block) => block.id === id)?.title ?? id
  const change = (index: number, patch: Partial<DraftStep>): void => {
    setSteps((held) => held.map((step, at) => (at === index ? { ...step, ...patch } : step)))
  }
  const movable = (index: number): boolean => {
    const step = steps[index]
    return step !== undefined && !LOCKED.includes(step.status)
  }
  const swap = (index: number, other: number): void => {
    setSteps((held) => {
      const next = [...held]
      const [left, right] = [next[index], next[other]]
      if (left === undefined || right === undefined) return held
      next[index] = right
      next[other] = left
      return next
    })
  }
  return (
    <div className="plan-editor">
      <ol>
        {steps.map((step, index) =>
          LOCKED.includes(step.status) ? (
            <li key={step.key} data-status={step.status}>
              {titleOf(step.block)}：{step.focus}
              <span className="hint">（已开始，不能改）</span>
            </li>
          ) : (
            <li key={step.key} data-status={step.restore === true ? 'pending' : step.status}>
              <select
                aria-label={`第 ${index + 1} 步的活动`}
                value={step.block}
                onChange={(event) => change(index, { block: event.target.value })}
              >
                {props.blocks.map((block) => (
                  <option key={block.id} value={block.id}>
                    {block.title}
                  </option>
                ))}
              </select>
              <input
                aria-label={`第 ${index + 1} 步的内容`}
                value={step.focus}
                onChange={(event) => change(index, { focus: event.target.value })}
              />
              <input
                type="number"
                className="step-minutes"
                aria-label={`第 ${index + 1} 步的分钟数`}
                min={0}
                max={600}
                value={step.minutes}
                onChange={(event) => change(index, { minutes: Number(event.target.value) })}
              />
              <span className="quiet-actions">
                <button
                  type="button"
                  className="link"
                  disabled={!movable(index - 1)}
                  aria-label={`上移第 ${index + 1} 步`}
                  onClick={() => swap(index, index - 1)}
                >
                  上移
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={!movable(index + 1)}
                  aria-label={`下移第 ${index + 1} 步`}
                  onClick={() => swap(index, index + 1)}
                >
                  下移
                </button>
                <button
                  type="button"
                  className="link"
                  aria-label={`删除第 ${index + 1} 步`}
                  onClick={() => setSteps((held) => held.filter((_, at) => at !== index))}
                >
                  删除
                </button>
                {step.status === 'skipped' && step.restore !== true && (
                  <button
                    type="button"
                    className="link"
                    aria-label={`放回第 ${index + 1} 步`}
                    onClick={() => change(index, { restore: true, minutes: step.minutes || 5 })}
                  >
                    放回来
                  </button>
                )}
              </span>
            </li>
          ),
        )}
      </ol>
      <p className="decisions">
        <button
          type="button"
          className="link"
          onClick={() => {
            setAdded(added + 1)
            setSteps((held) => [
              ...held,
              {
                key: `new-${added}`,
                block: props.blocks[0]?.id ?? '',
                focus: props.plan.topic,
                minutes: 5,
                status: 'pending',
              },
            ])
          }}
        >
          加一步
        </button>
        <button
          type="button"
          onClick={() =>
            props.onSave(
              steps.map(({ id, block, focus, minutes, restore }) => ({
                ...(id === undefined ? {} : { id }),
                block,
                focus,
                minutes,
                ...(restore === true ? { restore } : {}),
              })),
            )
          }
        >
          保存计划
        </button>
        <button type="button" className="link" onClick={props.onCancel}>
          不改了
        </button>
      </p>
    </div>
  )
}

/** Three numbers from three kinds of evidence, side by side and never added up. */
export function StatusView(props: { space: string | undefined; version: number }) {
  const { space, version } = props
  const [status, setStatus] = useState<Status>()
  const [failure, setFailure] = useState<string>()
  useEffect(() => {
    if (space === undefined) return undefined
    let current = true
    api
      .status(space)
      .then((reply) => {
        if (current) setStatus(reply)
      })
      .catch((error: unknown) => {
        if (current) setFailure(messageOf(error))
      })
    return () => {
      current = false
    }
  }, [space, version])
  if (failure !== undefined) return <p className="hint">{failure}</p>
  if (status === undefined) return <p className="hint">选一个空间后这里会显示学习记录。</p>
  const { estimated } = status
  const judged = estimated.correct + estimated.partial + estimated.wrong + estimated.unjudged
  return (
    <div className="status">
      <dl>
        <div>
          <dt>练习正确率</dt>
          <dd>
            {status.checked.total === 0
              ? '还没有可判分的题'
              : `${status.checked.correct} / ${status.checked.total}`}
          </dd>
          <dd className="hint">选择题和填空，由程序对照答案判定。</dd>
        </div>
        <div>
          <dt>模型估计</dt>
          <dd>
            {judged === 0
              ? '还没有'
              : `对 ${estimated.correct}，部分对 ${estimated.partial}，不对 ${estimated.wrong}${
                  estimated.unjudged > 0 ? `，未判断 ${estimated.unjudged}` : ''
                }`}
          </dd>
          <dd className="hint">简答题由模型评价，可能看错。</dd>
        </div>
        <div>
          <dt>你确认的理解</dt>
          <dd>{status.confirmed} 条</dd>
          <dd className="hint">只有你亲自确认过的才算。</dd>
        </div>
      </dl>
      <p className="hint">这三项来源不同，不能相加，也都不等于你实际理解了多少。</p>
      {status.review.length > 0 && (
        <section>
          <h3>建议回头看</h3>
          <ul>
            {status.review.map((item) => (
              <li key={item.focus}>
                <span>{item.focus}</span>
                <span className="hint">
                  {item.reason}
                  {item.due
                    ? '现在就可以看。'
                    : `${new Date(item.dueAt).toLocaleDateString('zh-CN')} 之后再看。`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {status.plans.length > 0 && (
        <section>
          <h3>计划进度</h3>
          <ul>
            {status.plans.map((plan) => (
              <li key={plan.id}>
                <span>{plan.topic}</span>
                <span className="hint">
                  {plan.done} / {plan.total} 步{plan.status === 'paused' && '，已暂停'}
                  {plan.status === 'done' && '，已结束'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
