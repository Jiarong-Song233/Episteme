import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { workbenchProfile, type ModelClient } from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * A candidate an agent proposes without naming a space waits for its owner on a page of its own. It is never put in
 * a space by itself; the person confirms it as it is, confirms it into a space they pick, or turns it down, and an
 * agent can do none of those.
 */

const quiet: ModelClient = {
  name: 'none',
  simulated: true,
  complete: () => Promise.reject(new Error('this story needs no model')),
}

interface Unfiled {
  readonly id: string
  readonly owner: string
  readonly proposedBy: string
  readonly proposedAt: string
  readonly rationale: string
  readonly basis?: string
  readonly wordsBy?: string
  readonly fileable: boolean
  readonly scope?: string
  readonly proposal: { readonly kind: string; readonly label?: string }
}

let directory: string
let service: EpistemeService

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-unfiled-'))
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

async function call<T = Record<string, unknown>>(path: string, token: string, body?: unknown) {
  const response = await fetch(`${service.apiUrl}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) as T & { code?: string } }
}

const scene = <T>(path: string, token: string, body?: unknown) =>
  call<T>(`/scene/workbench${path}`, token, body)

const unfiled = async (token: string) =>
  (await scene<{ pending: readonly Unfiled[] }>('/understanding/unfiled', token)).body.pending

const inSpace = async (token: string, space: string) =>
  (
    await scene<{
      nodes: readonly { label: string }[]
      pending: readonly { id: string }[]
    }>(`/understanding?space=${space}`, token)
  ).body

function agentWire(token: string | undefined, name = 'Notes Agent') {
  const wire = mcpWire(() => service.mcpUrl, { name, version: '1' })
  const headers = token === undefined ? undefined : { authorization: `Bearer ${token}` }
  return {
    propose: async (label: string, scope?: string) => {
      const result = await wire.call(
        'propose',
        {
          kind: 'claim',
          label,
          rationale: '学生在对话里这样说',
          ...(scope === undefined ? {} : { scope }),
        },
        {},
        headers === undefined ? {} : { headers },
      )
      if (result.isError === true) throw new Error(JSON.stringify(result))
      return (result.structuredContent?.['suggestion'] as { id: string }).id
    },
  }
}

describe('on one computer', () => {
  let person: string

  beforeEach(async () => {
    service = await startService({
      port: 0,
      graph: join(directory, 'graph.db'),
      profile: workbenchProfile({ model: quiet }),
    })
    person = service.humanToken ?? ''
  })

  it('shows a candidate proposed without a space, with who proposed it and for whom', async () => {
    const { space } = (
      await scene<{ space: { id: string } }>('/spaces', person, { name: '机器学习' })
    ).body
    const id = await agentWire(undefined).propose('位置编码告诉模型词的先后')

    const [shown] = await unfiled(person)
    expect(shown).toMatchObject({
      id,
      owner: 'actor_human',
      proposal: { kind: 'claim', label: '位置编码告诉模型词的先后' },
      rationale: '学生在对话里这样说',
      fileable: true,
    })
    expect(shown?.proposedBy).toMatch(/^actor_agent_/)
    expect(shown?.proposedAt).toBeTruthy()
    expect(shown?.scope).toBeUndefined()
    // Not put in a space by itself: no space lists it, waiting or held.
    expect((await inSpace(person, space.id)).pending).toEqual([])
  })

  it('lists only what has no space', async () => {
    const { space } = (
      await scene<{ space: { id: string } }>('/spaces', person, { name: '机器学习' })
    ).body
    const agent = agentWire(undefined)
    const loose = await agent.propose('没有空间的一条')
    const placed = await agent.propose('有空间的一条', `workbench:${space.id}`)
    const ids = (await unfiled(person)).map((each) => each.id)
    expect(ids).toEqual([loose])
    expect((await inSpace(person, space.id)).pending.map((each) => each.id)).toEqual([placed])
  })

  it('files it in the space the person picks when they confirm it', async () => {
    const { space } = (
      await scene<{ space: { id: string } }>('/spaces', person, { name: '机器学习' })
    ).body
    const id = await agentWire(undefined).propose('位置编码告诉模型词的先后')
    const decided = await call('/suggestions/decide', person, {
      id,
      action: 'accept',
      scope: `workbench:${space.id}`,
    })
    expect(decided.status).toBe(200)
    expect(await unfiled(person)).toEqual([])
    expect((await inSpace(person, space.id)).nodes.map((node) => node.label)).toEqual([
      '位置编码告诉模型词的先后',
    ])
  })

  it('confirms it as it is, in no space, when the person picks none', async () => {
    const { space } = (
      await scene<{ space: { id: string } }>('/spaces', person, { name: '机器学习' })
    ).body
    const id = await agentWire(undefined).propose('一条不属于任何空间的理解')
    expect((await call('/suggestions/decide', person, { id, action: 'accept' })).status).toBe(200)
    expect(await unfiled(person)).toEqual([])
    expect((await inSpace(person, space.id)).nodes).toEqual([])
    const state = (await (await fetch(`${service.apiUrl}/state`)).json()) as {
      nodes: { label: string; tags?: string[] }[]
    }
    const node = state.nodes.find((each) => each.label === '一条不属于任何空间的理解')
    expect(node?.tags?.some((tag) => tag.startsWith('scope:')) ?? false).toBe(false)
  })

  it('refuses a scope that is not text before deciding anything', async () => {
    const id = await agentWire(undefined).propose('一条')
    const refused = await call('/suggestions/decide', person, { id, action: 'accept', scope: 5 })
    expect(refused.status).toBe(400)
    expect((await unfiled(person)).map((each) => each.id)).toEqual([id])
  })

  it('says so when the person already holds the very same words', async () => {
    const agent = agentWire(undefined)
    const first = await agent.propose('同样的一句话')
    expect(
      (await call('/suggestions/decide', person, { id: first, action: 'accept' })).status,
    ).toBe(200)
    const again = await agent.propose('同样的一句话')
    const other = await agent.propose('另一句话')
    const shown = await unfiled(person)
    expect(shown.find((each) => each.id === again)).toMatchObject({ held: true })
    expect(shown.find((each) => each.id === other)).not.toHaveProperty('held')
  })

  it('lets the person turn it down', async () => {
    const id = await agentWire(undefined).propose('不对的一条')
    expect((await call('/suggestions/decide', person, { id, action: 'dismiss' })).status).toBe(200)
    expect(await unfiled(person)).toEqual([])
  })

  it('refuses to move a candidate that already has a space', async () => {
    const made = async (name: string) =>
      (await scene<{ space: { id: string } }>('/spaces', person, { name })).body.space.id
    const first = await made('甲')
    const second = await made('乙')
    const id = await agentWire(undefined).propose('属于甲的一条', `workbench:${first}`)
    const refused = await call('/suggestions/decide', person, {
      id,
      action: 'accept',
      scope: `workbench:${second}`,
    })
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe('scope_fixed')
    expect((await inSpace(person, first)).pending.map((each) => each.id)).toEqual([id])
  })

  it('gives the agent no way to confirm one', async () => {
    const wire = mcpWire(() => service.mcpUrl, { name: 'Notes Agent', version: '1' })
    const listed = await wire.rpc('tools/list')
    const names = (
      (listed.body['result'] as { tools: readonly { name: string }[] }).tools ?? []
    ).map((tool) => tool.name)
    expect(names.some((name) => /decide|confirm|accept/.test(name))).toBe(false)
  })
})

describe('with several people', () => {
  let lin: { id: string; token: string; agent: string }
  let mei: { id: string; token: string; agent: string }

  beforeEach(async () => {
    const users = join(directory, 'users.json')
    const person = async (name: string) => {
      const id = await addPerson(users, name)
      return {
        id,
        token: await addToken(users, id, 'human', 'workbench'),
        agent: await addToken(users, id, 'agent', `${name} 的 Agent`),
      }
    }
    lin = await person('林')
    mei = await person('梅')
    service = await startService({
      port: 0,
      graph: join(directory, 'shared.db'),
      profile: workbenchProfile({ model: quiet }),
      mode: 'shared',
      users,
      publicOrigin: 'https://workbench.example.edu',
    })
  })

  /** Every node Lin can see, and whether one of Lin's spaces shows it. */
  async function reachable(spaces: readonly string[]) {
    const state = (await call<{ nodes: { nodeId: string; label: string }[] }>('/state', lin.token))
      .body.nodes
    const shown = new Set<string>()
    for (const space of spaces) {
      for (const node of (
        await scene<{ nodes: readonly { nodeId: string }[] }>(
          `/understanding?space=${space}`,
          lin.token,
        )
      ).body.nodes) {
        shown.add(node.nodeId)
      }
    }
    return state.map((node) => ({ label: node.label, shown: shown.has(node.nodeId) }))
  }

  it('refuses to file a candidate in a workbench space that does not exist', async () => {
    const { space } = (
      await scene<{ space: { id: string } }>('/spaces', lin.token, { name: '林的空间' })
    ).body
    const id = await agentWire(lin.agent).propose('归到一个不存在的空间')
    const refused = await call('/suggestions/decide', lin.token, {
      id,
      action: 'accept',
      scope: 'workbench:sp_does-not-exist',
    })
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe('unknown_space')
    // Nothing landed where no page shows it, and the candidate still waits.
    expect(await reachable([space.id])).toEqual([])
    expect((await unfiled(lin.token)).map((each) => each.id)).toEqual([id])
  })

  it("refuses to file a candidate in another person's space", async () => {
    const { space: linsSpace } = (
      await scene<{ space: { id: string } }>('/spaces', lin.token, { name: '林的空间' })
    ).body
    const { space: meisSpace } = (
      await scene<{ space: { id: string } }>('/spaces', mei.token, { name: '梅的空间' })
    ).body
    const id = await agentWire(lin.agent).propose('归到梅的空间')
    const refused = await call('/suggestions/decide', lin.token, {
      id,
      action: 'accept',
      scope: `workbench:${meisSpace.id}`,
    })
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe('unknown_space')
    expect(await reachable([linsSpace.id])).toEqual([])
    expect(
      (
        await scene<{ nodes: readonly unknown[] }>(
          `/understanding?space=${meisSpace.id}`,
          mei.token,
        )
      ).body.nodes,
    ).toEqual([])
    expect((await unfiled(lin.token)).map((each) => each.id)).toEqual([id])
  })

  it('checks the space however the request names it: padded, reworded or archived', async () => {
    const { space } = (
      await scene<{ space: { id: string } }>('/spaces', lin.token, { name: '要归档的空间' })
    ).body
    const id = await agentWire(lin.agent).propose('一条')
    const padded = await call('/suggestions/decide', lin.token, {
      id,
      action: 'accept',
      scope: '  workbench:sp_does-not-exist  ',
    })
    expect(padded.body.code).toBe('unknown_space')
    const reworded = await call('/suggestions/decide', lin.token, {
      id,
      action: 'modify',
      scope: `workbench:${mei.id}`,
      proposal: { kind: 'claim', label: '改过的一条' },
    })
    expect(reworded.body.code).toBe('unknown_space')
    await scene('/spaces/update', lin.token, { space: space.id, archived: true })
    const archived = await call('/suggestions/decide', lin.token, {
      id,
      action: 'accept',
      scope: `workbench:${space.id}`,
    })
    expect(archived.body.code).toBe('space_archived')
    expect((await unfiled(lin.token)).map((each) => each.id)).toEqual([id])
  })

  it('still files a scope outside the workbench as the engine always has', async () => {
    const id = await agentWire(lin.agent).propose('一个通用的 scope')
    const decided = await call('/suggestions/decide', lin.token, {
      id,
      action: 'accept',
      scope: 'ml-2026',
    })
    expect(decided.status).toBe(200)
  })

  it('shows each person only their own, and only the owner can decide it', async () => {
    const linsId = await agentWire(lin.agent).propose('林的 Agent 提出的一条')
    const meisId = await agentWire(mei.agent).propose('梅的 Agent 提出的一条')

    const linSees = await unfiled(lin.token)
    expect(linSees.map((each) => each.id)).toEqual([linsId])
    expect(linSees[0]?.owner).toBe(lin.id)
    expect((await unfiled(mei.token)).map((each) => each.id)).toEqual([meisId])

    // Mei cannot decide Lin's, with or without a space of her own.
    const { space } = (
      await scene<{ space: { id: string } }>('/spaces', mei.token, { name: '梅的空间' })
    ).body
    const crossed = await call('/suggestions/decide', mei.token, {
      id: linsId,
      action: 'accept',
      scope: `workbench:${space.id}`,
    })
    expect(crossed.status).toBeGreaterThanOrEqual(400)
    expect((await unfiled(lin.token)).map((each) => each.id)).toEqual([linsId])

    // Lin's agent cannot decide it either; only Lin can.
    const byAgent = await call('/suggestions/decide', lin.agent, { id: linsId, action: 'accept' })
    expect(byAgent.status).toBe(403)
    expect((await unfiled(lin.token)).map((each) => each.id)).toEqual([linsId])

    const { space: linsSpace } = (
      await scene<{ space: { id: string } }>('/spaces', lin.token, { name: '林的空间' })
    ).body
    const decided = await call('/suggestions/decide', lin.token, {
      id: linsId,
      action: 'accept',
      scope: `workbench:${linsSpace.id}`,
    })
    expect(decided.status).toBe(200)
    expect((await inSpace(lin.token, linsSpace.id)).nodes.map((node) => node.label)).toEqual([
      '林的 Agent 提出的一条',
    ])
    expect((await unfiled(mei.token)).map((each) => each.id)).toEqual([meisId])
  })
})
