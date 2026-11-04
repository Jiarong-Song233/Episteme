import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { SimulatedModel, workbenchProfile, type Space } from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * A learner's words may reach Episteme from the person or through their agent, and evidence rests on them either way,
 * so the turn keeps which it was (ADR 0021). It comes from the credential, so a request cannot claim it.
 */

interface Turn {
  readonly id: string
  readonly by: string
  readonly writtenWith?: string
}

let directory: string
let service: EpistemeService

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(`${service.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

const openThread = async (token?: string): Promise<string> =>
  (await post<{ thread: { id: string } }>('/threads', { title: 'Positions' }, token)).thread.id

const say = async (thread: string, token?: string, extra: object = {}): Promise<Turn> =>
  (
    await post<{ turn: Turn }>(
      `/threads/${thread}/turns`,
      { speaker: 'learner', text: '位置编码可以省略吗？', ...extra },
      token,
    )
  ).turn

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-turn-source-'))
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('on one machine', () => {
  beforeEach(async () => {
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel() }),
    })
  })

  it('marks what the person sends with their own token as theirs', async () => {
    const token = service.humanToken
    const turn = await say(await openThread(token), token)
    expect(turn.writtenWith).toBe('person')
  })

  it('says nothing about a turn sent with no credential, because nobody knows who wrote it', async () => {
    const turn = await say(await openThread())
    expect(turn.writtenWith).toBeUndefined()
  })

  it('does not take the source from the request', async () => {
    const turn = await say(await openThread(), undefined, { writtenWith: 'person' })
    expect(turn.writtenWith).toBeUndefined()
  })

  it('marks a question asked on the page as the person’s', async () => {
    const token = service.humanToken
    const scene = '/scene/workbench'
    const { space } = await post<{ space: Space }>(`${scene}/spaces`, { name: '学习' }, token)
    const asked = await post<{ thread: string; turn: string }>(
      `${scene}/ask`,
      { space: space.id, question: '位置编码有什么用' },
      token,
    )
    const response = await fetch(`${service.apiUrl}/threads/${asked.thread}`, {
      headers: { authorization: `Bearer ${token ?? ''}` },
    })
    const { turns } = (await response.json()) as { turns: readonly Turn[] }
    expect(turns.find((turn) => turn.id === asked.turn)?.writtenWith).toBe('person')
  })

  it('marks a turn from a host with no token as relayed', async () => {
    const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
    const opened = await host.call('thread_open', { title: 'Positions' })
    const thread = (opened.structuredContent?.['thread'] as { id: string }).id
    const appended = await host.call('thread_append', {
      thread,
      speaker: 'learner',
      text: '位置编码可以省略吗？',
    })
    const turn = appended.structuredContent?.['turn'] as Turn
    expect(turn.writtenWith).toBe('agent')
    expect(turn.by).toBe('actor_agent_claude-code')
  })

  describe('where the person reviews it', () => {
    const scene = '/scene/workbench'

    interface Read {
      readonly nodes: readonly { readonly nodeId: string; readonly wordsBy?: string }[]
      readonly pending: readonly { readonly id: string; readonly wordsBy?: string }[]
    }

    const get = async <T>(path: string): Promise<T> => {
      const response = await fetch(`${service.apiUrl}${path}`, {
        headers: { authorization: `Bearer ${service.humanToken ?? ''}` },
      })
      expect(response.status).toBe(200)
      return (await response.json()) as T
    }

    const newSpace = async (): Promise<Space> =>
      (await post<{ space: Space }>(`${scene}/spaces`, { name: '学习' }, service.humanToken)).space

    /** Offers one learner turn as a candidate, the way the page does. */
    const offered = async (space: Space, thread: string, turn: string) => {
      await post(`${scene}/candidates/turn`, { space: space.id, thread, turn }, service.humanToken)
      const { pending } = await get<Read>(`${scene}/understanding?space=${space.id}`)
      expect(pending).toHaveLength(1)
      return pending[0]
    }

    const scopedThread = async (space: Space): Promise<string> =>
      (
        await post<{ thread: { id: string } }>('/threads', {
          title: 'Positions',
          scope: `workbench:${space.id}`,
        })
      ).thread.id

    it('says the person’s own words are theirs', async () => {
      const space = await newSpace()
      const asked = await post<{ thread: string; turn: string }>(
        `${scene}/ask`,
        { space: space.id, question: '位置编码是为了告诉模型顺序' },
        service.humanToken,
      )
      expect((await offered(space, asked.thread, asked.turn))?.wordsBy).toBe('person')
    })

    it('says relayed words were relayed, on the candidate and after it is accepted', async () => {
      const space = await newSpace()
      const thread = await scopedThread(space)
      const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
      const appended = await host.call('thread_append', {
        thread,
        speaker: 'learner',
        text: '位置编码是为了告诉模型顺序',
      })
      const turn = (appended.structuredContent?.['turn'] as Turn).id

      const candidate = await offered(space, thread, turn)
      expect(candidate?.wordsBy).toBe('agent')

      await post('/suggestions/decide', { id: candidate?.id, action: 'accept' }, service.humanToken)
      const { nodes } = await get<Read>(`${scene}/understanding?space=${space.id}`)
      expect(nodes[0]?.wordsBy).toBe('agent')
      const { trail } = await get<{ trail: readonly { kind: string; wordsBy?: string }[] }>(
        `${scene}/understanding/trail?space=${space.id}&node=${nodes[0]?.nodeId ?? ''}`,
      )
      expect(trail.find((entry) => entry.kind === 'proposed')?.wordsBy).toBe('agent')
    })

    it('does not guess when nobody knows who wrote the words', async () => {
      const space = await newSpace()
      const thread = await scopedThread(space)
      const turn = await say(thread)
      expect((await offered(space, thread, turn.id))?.wordsBy).toBe('unrecorded')
    })

    it('says a host’s own claim that the words are the person’s came through the host', async () => {
      const space = await newSpace()
      const words = '位置编码是为了告诉模型顺序'
      const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
      const sent = await host.call('distill', {
        text: `User: ${words}\nAssistant: 对。`,
        learner: 'User',
        scope: `workbench:${space.id}`,
        submissionId: 'reading',
        candidates: [
          {
            kind: 'node',
            ref: 'words',
            role: 'claim',
            label: words,
            quote: words,
            basis: 'stated',
            rationale: '他自己这样说的',
          },
        ],
      })
      expect(sent.isError ?? false, JSON.stringify(sent.structuredContent)).toBe(false)
      const { pending } = await get<Read>(`${scene}/understanding?space=${space.id}`)
      expect(pending, JSON.stringify(sent.structuredContent)).toHaveLength(1)
      expect(pending[0], JSON.stringify(pending)).toMatchObject({ wordsBy: 'agent' })
    })

    it('says so on what came of a session, without showing the words', async () => {
      const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
      const structured = async <T>(name: string, args: object): Promise<T> => {
        const answer = await host.call(name, { ...args })
        expect(answer.isError ?? false, JSON.stringify(answer.structuredContent)).toBe(false)
        return answer.structuredContent as T
      }
      const { space } = await structured<{ space: Space & { scope: string } }>('learn_space_open', {
        submission: 'space',
        name: '学习',
      })
      const { thread } = await structured<{ thread: { id: string } }>('thread_open', {
        title: 'Positions',
        scope: space.scope,
      })
      const { plan } = await structured<{
        plan: {
          id: string
          version: number
          steps: readonly { objective: string }[]
        }
      }>('learn_plan_start', {
        submission: 'plan',
        space: space.id,
        topic: '位置编码',
        thread: thread.id,
        steps: [{ activity: 'retell', label: '位置编码' }],
      })
      const words = '位置编码是为了告诉模型顺序'
      const { turn } = await structured<{ turn: Turn }>('thread_append', {
        thread: thread.id,
        speaker: 'learner',
        text: words,
      })
      await structured('learn_observe', {
        submission: 'said',
        plan: plan.id,
        planVersion: plan.version,
        objective: plan.steps[0]?.objective,
        kind: 'statement',
        thread: thread.id,
        turn: turn.id,
        quote: words,
      })

      const read = await get<{
        sessions: readonly {
          objectives: readonly { events: readonly { kind: string; wordsBy?: string }[] }[]
        }[]
      }>(`${scene}/outcomes?space=${space.id}`)
      const event = read.sessions[0]?.objectives[0]?.events.find(
        (each) => each.kind === 'statement',
      )
      expect(event?.wordsBy).toBe('agent')
      expect(JSON.stringify(read.sessions)).not.toContain(words)
    })
  })
})

describe('in a shared deployment', () => {
  let human: string
  let agent: string

  beforeEach(async () => {
    const users = join(directory, 'users.json')
    const lin = await addPerson(users, 'Lin')
    human = await addToken(users, lin, 'human', 'workspace')
    agent = await addToken(users, lin, 'agent', 'claude-code')
    service = await startService({
      port: 0,
      graph: join(directory, 'shared.db'),
      mode: 'shared',
      users,
      publicOrigin: 'https://episteme.example.edu',
    })
  })

  it('names the agent when its token writes the learner’s words over REST', async () => {
    const turn = await say(await openThread(human), agent)
    expect(turn.writtenWith).toBe('agent')
    expect(turn.by).toBe('actor_agent_claude-code')
  })

  it('does not let an agent claim the words are the person’s', async () => {
    const turn = await say(await openThread(human), agent, {
      writtenWith: 'person',
      by: 'actor_lin',
    })
    expect(turn.writtenWith).toBe('agent')
    expect(turn.by).toBe('actor_agent_claude-code')
  })

  it('marks a host as relaying even when it holds the person’s own token', async () => {
    const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
    const as = { headers: { authorization: `Bearer ${human}` } }
    const opened = await host.call('thread_open', { title: 'Positions' }, {}, as)
    const thread = (opened.structuredContent?.['thread'] as { id: string }).id
    const appended = await host.call(
      'thread_append',
      { thread, speaker: 'learner', text: '位置编码可以省略吗？' },
      {},
      as,
    )
    expect((appended.structuredContent?.['turn'] as Turn).writtenWith).toBe('agent')
  })
})
