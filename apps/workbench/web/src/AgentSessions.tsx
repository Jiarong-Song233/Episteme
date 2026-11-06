import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type AgentSessionDetail, type AgentSessionInfo } from './api.js'

/**
 * The conversations the agents of this computer keep for themselves, to look through and search. Read only, shown
 * to the person alone: none of it is sent to an agent or a model.
 */

const ROLES = { user: '你', assistant: 'Agent', tool: '工具' } as const

function when(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

export function AgentSessionsPage(props: {
  agent: string | undefined
  session: string | undefined
  onOpen: (agent: string | undefined, session?: string) => void
}) {
  const [agents, setAgents] = useState<readonly { id: string; name: string; found: boolean }[]>([])
  const [sessions, setSessions] = useState<readonly AgentSessionInfo[]>()
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  const [problem, setProblem] = useState<string>()
  const [detail, setDetail] = useState<AgentSessionDetail>()

  useEffect(() => {
    setSessions(undefined)
    setProblem(undefined)
    api
      .agentSessions(props.agent, query)
      .then((reply) => {
        setAgents(reply.agents)
        setSessions(reply.sessions)
      })
      .catch((error: unknown) =>
        setProblem(error instanceof ApiError ? error.message : '读不到会话记录。'),
      )
  }, [props.agent, query])

  useEffect(() => {
    setDetail(undefined)
    if (props.agent === undefined || props.session === undefined) return
    api
      .agentSession(props.agent, props.session)
      .then((reply) => setDetail(reply.session))
      .catch((error: unknown) =>
        setProblem(error instanceof ApiError ? error.message : '读不到这个会话。'),
      )
  }, [props.agent, props.session])

  const nameOf = (id: string): string => agents.find((agent) => agent.id === id)?.name ?? id
  const search = (event: FormEvent): void => {
    event.preventDefault()
    setQuery(typed.trim())
  }

  if (props.session !== undefined && props.agent !== undefined) {
    return (
      <div className="page connect">
        <button type="button" className="link" onClick={() => props.onOpen(props.agent)}>
          ← 回到 {nameOf(props.agent)} 的会话
        </button>
        {problem !== undefined && (
          <p className="banner banner-error" role="status">
            {problem}
          </p>
        )}
        {detail === undefined ? (
          problem === undefined && <p className="hint">正在读取…</p>
        ) : (
          <>
            <h2 className="space-title">{detail.summary.title}</h2>
            <p className="hint page-hint">
              {[
                nameOf(detail.summary.agent),
                detail.summary.project,
                when(detail.summary.updatedAt),
              ]
                .filter((part) => part !== undefined)
                .join('，')}
              {detail.truncated ? '。内容太长，只显示了前面一部分。' : ''}
            </p>
            <ol className="agent-transcript">
              {detail.messages.map((message, index) => (
                <li key={index} data-role={message.role}>
                  <span className="hint">{ROLES[message.role]}</span>
                  <div className="agent-message">{message.text}</div>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="page connect">
      <h2 className="space-title">Agent 会话记录</h2>
      <p className="hint page-hint">
        这台电脑上的 Agent 自己保存的对话，只读。它们只显示给你，不会发给任何 Agent 或模型。
      </p>
      <div className="agent-tabs" role="group" aria-label="按 Agent 看">
        <button
          type="button"
          aria-pressed={props.agent === undefined}
          onClick={() => props.onOpen(undefined)}
        >
          全部
        </button>
        {agents
          .filter((agent) => agent.found)
          .map((agent) => (
            <button
              key={agent.id}
              type="button"
              aria-pressed={props.agent === agent.id}
              onClick={() => props.onOpen(agent.id)}
            >
              {agent.name}
            </button>
          ))}
      </div>
      <form className="inline-form agent-search" onSubmit={search}>
        <input
          aria-label="搜索会话"
          placeholder="搜索标题、项目或对话里的词"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="submit">搜索</button>
        {query !== '' && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setTyped('')
              setQuery('')
            }}
          >
            清除
          </button>
        )}
      </form>
      {problem !== undefined && (
        <p className="banner banner-error" role="status">
          {problem}
        </p>
      )}
      <section className="panel">
        {sessions === undefined ? (
          <p className="hint">{query === '' ? '正在读取…' : '正在搜索…'}</p>
        ) : sessions.length === 0 ? (
          <p className="hint">
            {query !== ''
              ? '没有找到。搜索只看每个 Agent 最近的会话。'
              : agents.some((agent) => agent.found)
                ? '还没有会话记录。'
                : '没有找到能读的会话记录。支持 Claude Code、Codex、Gemini CLI、Qwen Code、Kimi CLI 和 opencode。'}
          </p>
        ) : (
          <ul className="agents">
            {sessions.map((session) => (
              <li className="agent" key={`${session.agent}:${session.id}`}>
                <div className="agent-head">
                  <div className="agent-name">
                    <button
                      type="button"
                      className="link conversation-title"
                      onClick={() => props.onOpen(session.agent, session.id)}
                    >
                      {session.title}
                    </button>
                  </div>
                  <span className="hint">{when(session.updatedAt)}</span>
                </div>
                <p className="hint agent-used">
                  {[nameOf(session.agent), session.project]
                    .filter((part) => part !== undefined)
                    .join('，')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
