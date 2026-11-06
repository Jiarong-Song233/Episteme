import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError, type ConversationInfo } from './api.js'

/**
 * Every conversation of the workbench, across spaces: who took part, and the person's own names and archiving.
 * Words are never changed or removed here, because understanding the person confirmed cites them as evidence.
 */

function when(at: number): string {
  const date = new Date(at)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString()
}

function who(conversation: ConversationInfo): string {
  const parts: string[] = []
  if (conversation.byPerson) parts.push('你')
  parts.push(...conversation.agents)
  if (parts.length === 0 && conversation.models.length > 0) parts.push(...conversation.models)
  return parts.length === 0 ? '还没有人发言' : parts.join('、')
}

function Row(props: {
  conversation: ConversationInfo
  onOpen: () => void
  onChanged: () => void
  onFailed: (message: string) => void
}) {
  const { conversation } = props
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(conversation.title)
  const [busy, setBusy] = useState(false)

  const change = (next: { title?: string; archived?: boolean }): void => {
    setBusy(true)
    api
      .updateConversation(conversation.id, next)
      .then(() => {
        setEditing(false)
        props.onChanged()
      })
      .catch((error: unknown) =>
        props.onFailed(error instanceof ApiError ? error.message : '没有改动，请重试。'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <li className="agent">
      <div className="agent-head">
        {editing ? (
          <form
            className="inline-form conversation-rename"
            onSubmit={(event) => {
              event.preventDefault()
              change({ title: title.trim() })
            }}
          >
            <input
              aria-label="对话的新名字"
              value={title}
              maxLength={80}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
            <button type="submit" disabled={busy || title.trim() === ''}>
              保存
            </button>
            <button type="button" className="link" onClick={() => setEditing(false)}>
              取消
            </button>
          </form>
        ) : (
          <div className="agent-name">
            {conversation.space !== undefined && !conversation.archived ? (
              <button type="button" className="link conversation-title" onClick={props.onOpen}>
                {conversation.title}
              </button>
            ) : (
              <strong>{conversation.title}</strong>
            )}
          </div>
        )}
        {!editing && (
          <div className="agent-actions">
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => {
                setTitle(conversation.title)
                setEditing(true)
              }}
            >
              重命名
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => change({ archived: !conversation.archived })}
            >
              {conversation.archived ? '移回列表' : '归档'}
            </button>
          </div>
        )}
      </div>
      <p className="hint agent-used">
        {[
          conversation.space?.name ?? 'Agent 开的对话',
          who(conversation),
          `${conversation.turns} 条`,
          when(conversation.lastAt),
        ].join('，')}
      </p>
    </li>
  )
}

export function ConversationsPage(props: { onOpen: (space: string, thread: string) => void }) {
  const [archived, setArchived] = useState(false)
  const [conversations, setConversations] = useState<readonly ConversationInfo[]>()
  const [filter, setFilter] = useState('')
  const [by, setBy] = useState('')
  const [problem, setProblem] = useState<string>()

  const load = useCallback(() => {
    api
      .conversations(archived)
      .then((reply) => setConversations(reply.conversations))
      .catch((error: unknown) =>
        setProblem(error instanceof ApiError ? error.message : '读不到对话列表。'),
      )
  }, [archived])
  useEffect(load, [load])

  const people = useMemo(() => {
    const names = new Set<string>()
    for (const conversation of conversations ?? []) {
      if (conversation.byPerson) names.add('你')
      for (const agent of conversation.agents) names.add(agent)
    }
    return [...names]
  }, [conversations])

  const shown = (conversations ?? []).filter((conversation) => {
    const words = filter.trim().toLowerCase()
    if (
      words !== '' &&
      !`${conversation.title} ${conversation.space?.name ?? ''}`.toLowerCase().includes(words)
    ) {
      return false
    }
    if (by === '') return true
    return by === '你' ? conversation.byPerson : conversation.agents.includes(by)
  })

  return (
    <div className="page connect">
      <h2 className="space-title">对话</h2>
      <p className="hint page-hint">
        所有空间里的对话，包括 Agent 通过 MCP
        开的。可以重命名、归档。对话不能彻底删除：你确认过的理解把对话原话当作依据，记录只会追加；归档后它就不在列表里了，随时可以移回。
      </p>
      {problem !== undefined && (
        <p className="banner banner-error" role="status">
          {problem}
        </p>
      )}
      <section className="panel">
        <div className="filters conversation-filters">
          <input
            aria-label="按名字找对话"
            placeholder="按名字或空间找"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <select
            aria-label="按参与者筛选"
            value={by}
            onChange={(event) => setBy(event.target.value)}
          >
            <option value="">所有参与者</option>
            {people.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button type="button" className="link" onClick={() => setArchived((was) => !was)}>
            {archived ? '看列表里的' : '看已归档的'}
          </button>
        </div>
        {conversations === undefined ? (
          <p className="hint">正在读取…</p>
        ) : shown.length === 0 ? (
          <p className="hint">
            {archived ? '没有归档的对话。' : '没有对话。在一个空间里提个问题，或让 Agent 来讲解。'}
          </p>
        ) : (
          <ul className="agents">
            {shown.map((conversation) => (
              <Row
                key={`${conversation.id}:${conversation.title}:${conversation.archived}`}
                conversation={conversation}
                onOpen={() => props.onOpen(conversation.space!.id, conversation.id)}
                onChanged={load}
                onFailed={setProblem}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
