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
