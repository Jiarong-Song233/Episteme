import { useState, type FormEvent } from 'react'
import { api, type ModelInfo, type Space } from './api.js'

/**
 * The first visit: nothing is here yet. Three steps in the order they are needed, each one done right here, and the
 * one rule that makes this different from a chat: only what the person confirms counts.
 */
export function Welcome(props: {
  model: ModelInfo | undefined
  guard: (work: () => Promise<unknown>) => void
  onModel: () => void
  onConnect: () => void
  onCreated: (space: Space) => void
}) {
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const modelReady = props.model !== undefined && !props.model.simulated

  const create = (event: FormEvent): void => {
    event.preventDefault()
    const wanted = name.trim()
    if (wanted === '' || creating) return
    setCreating(true)
    props.guard(async () => {
      try {
        props.onCreated((await api.createSpace(wanted)).space)
      } finally {
        setCreating(false)
      }
    })
  }

  return (
    <div className="page welcome">
      <h2 className="welcome-title">把读过的东西，变成你自己的理解</h2>
      <p className="welcome-lead">
        放进材料，提问、学习、练习。从对话里提出来的要点，要等你确认才算数，之后的回答都会参考你确认过的理解。
      </p>

      <ol className="steps">
        <li className="step" data-done={modelReady}>
          <div>
            <h3>选一个模型</h3>
            <p className="hint">
              {modelReady
                ? `已设置：${props.model?.name ?? ''}。`
                : '回答和讲解要用语言模型。没有它，只能摘录材料原句。'}
            </p>
          </div>
          <button type="button" className={modelReady ? 'secondary' : ''} onClick={props.onModel}>
            {modelReady ? '更换' : '设置模型'}
          </button>
        </li>
        <li className="step">
          <div>
            <h3>为要学的东西建一个空间</h3>
            <p className="hint">一门课、一本书或一个课题各用一个空间，材料和理解都分开放。</p>
            <form className="inline-form" onSubmit={create}>
              <input
                aria-label="第一个空间的名字"
                placeholder="比如：线性代数"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" disabled={creating || name.trim() === ''}>
                建好并进入
              </button>
            </form>
          </div>
        </li>
        <li className="step">
          <div>
            <h3>让常用的 Agent 也能用（可选）</h3>
            <p className="hint">
              Claude Code、Codex 等可以读取你确认过的理解，也可以提出新的候选，但不能替你确认。
            </p>
          </div>
          <button type="button" className="secondary" onClick={props.onConnect}>
            接入 Agent
          </button>
        </li>
      </ol>
    </div>
  )
}
