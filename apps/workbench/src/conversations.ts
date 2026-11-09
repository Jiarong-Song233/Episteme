import { writtenWithOf, type SceneView, type Thread } from '@episteme/application'
import type { SceneRoute } from '@episteme/service'
import { refuse, SPACE_PREFIX, text, type Space } from './requests.js'

/**
 * The person's conversations across every space: who took part, and the names and archiving they chose.
 *
 * A conversation's words are never changed or removed: the log of turns only grows (ADR 0015), and understanding the
 * person confirmed cites those words as its evidence. What changes is how the person sees the conversation, kept in
 * its own record beside it: a title of their own, and whether it is archived out of the list.
 */

export const CONVERSATION_PREFIX = 'conversation:'
const MAX_TITLE = 80

export interface ConversationMeta {
  readonly title?: string
  readonly archived?: boolean
}

export function conversationMeta(view: SceneView, thread: string): ConversationMeta {
  return (
    (view.records.get(`${CONVERSATION_PREFIX}${thread}`)?.value as ConversationMeta | undefined) ??
    {}
  )
}

/** A thread as the person named it, and whether they archived it. */
export function shownThread(
  view: SceneView,
  thread: Thread,
): Thread & { readonly archived: boolean } {
  const meta = conversationMeta(view, thread.id)
  return {
    ...thread,
    ...(meta.title === undefined ? {} : { title: meta.title }),
    archived: meta.archived === true,
  }
}

/** Who an agent is from the actor it wrote as: `actor_agent_claude-code` is `claude-code`. */
function agentOf(by: string): string | undefined {
  if (by.startsWith('actor_agent_')) return by.slice('actor_agent_'.length)
  return undefined
}

export interface ConversationSummary {
  readonly id: string
  readonly title: string
  readonly space?: { readonly id: string; readonly name: string }
  readonly createdAt: number
  readonly lastAt: number
  readonly turns: number
  /** The agents that relayed turns into it, by the names they gave. */
  readonly agents: readonly string[]
  /** Whether the person wrote in it themselves, on this page. */
  readonly byPerson: boolean
  /** The model that answered, when the workbench did. */
  readonly models: readonly string[]
  readonly archived: boolean
}

export function conversationRoutes(): readonly SceneRoute[] {
  return [
    {
      method: 'GET',
      path: '/conversations',
      handle: ({ view, query }) => {
        const spaces = new Map(
          view.records.list(SPACE_PREFIX).map((record) => {
            const space = record.value as Space
            return [space.id, space] as const
          }),
        )
        const conversations: ConversationSummary[] = view.threads().map((thread) => {
          const shown = shownThread(view, thread)
          const turns = view.threadView(thread.id)?.turns ?? []
          const agents = new Set<string>()
          const models = new Set<string>()
          let byPerson = false
          for (const turn of turns) {
            const agent = agentOf(turn.by)
            if (
              agent !== undefined &&
              (writtenWithOf(turn) === 'agent' || turn.speaker === 'agent')
            )
              agents.add(agent)
            else if (turn.by.startsWith('model:')) models.add(turn.by.slice('model:'.length))
            else if (turn.speaker === 'learner' && writtenWithOf(turn) !== 'agent') byPerson = true
          }
          const spaceId =
            thread.scope?.startsWith('workbench:') === true ? thread.scope.slice(10) : undefined
          const space = spaceId === undefined ? undefined : spaces.get(spaceId)
          return {
            id: thread.id,
            title: shown.title === '' ? '（没有标题）' : shown.title,
            ...(space === undefined ? {} : { space: { id: space.id, name: space.name } }),
            createdAt: thread.createdAt,
            lastAt: turns.at(-1)?.at ?? thread.createdAt,
            turns: turns.length,
            agents: [...agents].sort(),
            byPerson,
            models: [...models].sort(),
            archived: shown.archived,
          }
        })
        const archived = query.get('archived') === '1'
        return {
          conversations: conversations
            .filter((conversation) => conversation.archived === archived)
            .sort((left, right) => right.lastAt - left.lastAt),
        }
      },
    },
    // The person's: an agent cannot rename or archive a conversation (route-access.ts names only proposing routes).
    {
      method: 'POST',
      path: '/conversations/update',
      handle: async ({ view, body }) => {
        const id = text(body, 'thread', 200)
        const thread = view.threadView(id)?.thread
        if (thread === undefined) refuse('unknown_thread', '这段对话不存在。')
        const kept = conversationMeta(view, id)
        let title = kept.title
        if (body['title'] !== undefined) {
          if (body['title'] === '' || body['title'] === null) title = undefined
          else title = text(body, 'title', MAX_TITLE).trim().replace(/\s+/g, ' ')
        }
        const archived = typeof body['archived'] === 'boolean' ? body['archived'] : kept.archived
        const meta: ConversationMeta = {
          ...(title === undefined ? {} : { title }),
          ...(archived === true ? { archived: true } : {}),
        }
        await view.records.put(`${CONVERSATION_PREFIX}${id}`, meta)
        return { conversation: shownThread(view, thread) }
      },
    },
  ]
}
