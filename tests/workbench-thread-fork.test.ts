import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { SimulatedModel, workbenchProfile } from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * A conversation's branches in the workbench: a new line from any turn it shows, the original and its other lines
 * untouched, each turn saying whether the branch carries it over or said it itself.
 */

let directory: string
let service: EpistemeService | undefined

interface Session {
  readonly id: string
  readonly title: string
  readonly parent?: { readonly thread: string; readonly turn: string }
  readonly ownTurns: number
}

interface ShownTurn {
  readonly id: string
  readonly text: string
  readonly speaker: string
  readonly inherited: boolean
}

async function call(path: string, body?: unknown, token = service?.humanToken) {
  const response = await fetch(`${service!.url}/api/v1/scene/workbench${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const sessionsIn = async (space: string, token?: string) =>
  (await call(`/sessions?space=${space}`, undefined, token)).body['sessions'] as Session[]

const turnsOf = async (thread: string, token?: string) =>
  (await call(`/session?thread=${thread}`, undefined, token)).body['turns'] as ShownTurn[]

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-thread-fork-'))
})

afterEach(async () => {
  await service?.close()
  service = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('branching a workbench conversation', () => {
  beforeEach(async () => {
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel() }),
    })
  })

  it('opens a branch from a turn, keeps the original, and marks what the branch carries over', async () => {
    const space = ((await call('/spaces', { name: '论文' })).body['space'] as { id: string }).id
    const first = await call('/ask', { space, question: '位置编码是什么？' })
    const thread = first.body['thread'] as string
    const asked = first.body['turn'] as string
    await call('/ask', { space, thread, question: '能不能省略？' })

    const forked = await call('/sessions/fork', { space, thread, turn: asked })
    expect(forked.status).toBe(200)
    const branch = forked.body['session'] as Session
    expect(branch).toMatchObject({
      title: '位置编码是什么？ · 分支 1',
      parent: { thread, turn: asked },
      ownTurns: 0,
    })

    // Only the asked turn is carried over: the answer to it and what followed stay on the original.
    expect(await turnsOf(branch.id)).toEqual([
      expect.objectContaining({ id: asked, inherited: true }),
    ])

    // Asking on the branch answers with only the branch's own way back.
    await call('/ask', { space, thread: branch.id, question: '换个角度：为什么需要顺序？' })
    const onBranch = await turnsOf(branch.id)
    expect(onBranch.map((turn) => turn.inherited)).toEqual([true, false, false])
    expect(onBranch.map((turn) => turn.text)).not.toContain('能不能省略？')

    const original = await turnsOf(thread)
    expect(original).toHaveLength(4)
    expect(original.every((turn) => !turn.inherited)).toBe(true)

    const second = (await call('/sessions/fork', { space, thread, turn: asked })).body[
      'session'
    ] as Session
    expect(second.title).toBe('位置编码是什么？ · 分支 2')

    const listed = await sessionsIn(space)
    expect(listed.find((session) => session.id === thread)).toMatchObject({ ownTurns: 4 })
    expect(listed.find((session) => session.id === branch.id)).toMatchObject({
      ownTurns: 2,
      parent: { thread, turn: asked },
    })
    expect(listed.find((session) => session.id === thread)?.parent).toBeUndefined()
  })

  it('branches a branch, from its own turns or the ones it carries over, with a title of the person’s', async () => {
    const space = ((await call('/spaces', { name: 's' })).body['space'] as { id: string }).id
    const first = await call('/ask', { space, question: '第一问' })
    const thread = first.body['thread'] as string
    const branch = (await call('/sessions/fork', { space, thread, turn: first.body['turn'] })).body[
      'session'
    ] as Session
    const own = (await call('/ask', { space, thread: branch.id, question: '分支上的问题' })).body[
      'turn'
    ] as string

    const deep = (
      await call('/sessions/fork', { space, thread: branch.id, turn: own, title: '  再  深一层 ' })
    ).body['session'] as Session
    expect(deep).toMatchObject({ title: '再 深一层', parent: { thread: branch.id, turn: own } })
    expect((await turnsOf(deep.id)).map((turn) => turn.text)).toEqual(['第一问', '分支上的问题'])

    const carried = await call('/sessions/fork', {
      space,
      thread: branch.id,
      turn: first.body['turn'],
    })
    expect(carried.status).toBe(200)
    expect((await turnsOf((carried.body['session'] as Session).id)).map((t) => t.text)).toEqual([
      '第一问',
    ])
  })

  it('refuses a turn the conversation does not show, another space’s conversation, and an archived space', async () => {
    const space = ((await call('/spaces', { name: 'a' })).body['space'] as { id: string }).id
    const other = ((await call('/spaces', { name: 'b' })).body['space'] as { id: string }).id
    const first = await call('/ask', { space, question: '问题' })
    const thread = first.body['thread'] as string
    const turn = first.body['turn'] as string
    const branch = (await call('/sessions/fork', { space, thread, turn })).body[
      'session'
    ] as Session
    const later = (await call('/ask', { space, thread, question: '后来的问题' })).body[
      'turn'
    ] as string

    // A turn of the original said after the fork point is not on the branch.
    expect(
      (await call('/sessions/fork', { space, thread: branch.id, turn: later })).body['code'],
    ).toBe('unknown_turn')
    expect(
      (await call('/sessions/fork', { space, thread, turn: 'turn_absent' })).body['code'],
    ).toBe('unknown_turn')
    expect((await call('/sessions/fork', { space: other, thread, turn })).body['code']).toBe(
      'unknown_thread',
    )
    expect((await call('/sessions/fork', { space, thread: 'thr_absent', turn })).body['code']).toBe(
      'unknown_thread',
    )

    await call('/spaces/update', { space, archived: true })
    expect((await call('/sessions/fork', { space, thread, turn })).body['code']).toBe(
      'space_archived',
    )
    // Nothing was opened by any of the refusals.
    await call('/spaces/update', { space, archived: false })
    expect(await sessionsIn(space)).toHaveLength(2)
  })
})

describe('branching in a shared service', () => {
  it('is the person’s own: not with an agent’s credential, and not on another person’s conversation', async () => {
    const users = join(directory, 'users.json')
    const lin = await addPerson(users, 'Lin')
    const wei = await addPerson(users, 'Wei')
    const linHuman = await addToken(users, lin, 'human', 'workspace')
    const linAgent = await addToken(users, lin, 'agent', 'claude-code')
    const weiHuman = await addToken(users, wei, 'human', 'workspace')
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      mode: 'shared',
      users,
      publicOrigin: 'http://127.0.0.1',
      profile: workbenchProfile({ model: new SimulatedModel() }),
    })
    const space = ((await call('/spaces', { name: 's' }, linHuman)).body['space'] as { id: string })
      .id
    const asked = await call('/ask', { space, question: 'q' }, linHuman)
    const thread = asked.body['thread'] as string
    const turn = asked.body['turn'] as string

    expect((await call('/sessions/fork', { space, thread, turn }, linAgent)).status).toBe(403)

    const weiSpace = (
      (await call('/spaces', { name: 'w' }, weiHuman)).body['space'] as {
        id: string
      }
    ).id
    expect(
      (await call('/sessions/fork', { space: weiSpace, thread, turn }, weiHuman)).body['code'],
    ).toBe('unknown_thread')
    expect((await call(`/session?thread=${thread}`, undefined, weiHuman)).status).toBe(422)

    expect(await sessionsIn(space, linHuman)).toHaveLength(1)
    expect(await sessionsIn(weiSpace, weiHuman)).toEqual([])
  })
})
