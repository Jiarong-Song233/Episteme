import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EpistemeService, startService } from '@episteme/service'
import {
  type ModelClient,
  type ModelMessage,
  type Plan,
  type PublicQuestion,
  workbenchProfile,
} from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type McpWire, mcpWire } from './mcp-wire.js'

/**
 * Practice on the page reaches what the person holds the way an agent's record does: once they have said which of
 * their understandings an objective is about, a wrong answer there puts a doubt to them. Saying so changes nothing they
 * hold, and only they can say it.
 */

const NOTES = `# Transformer 笔记

## 位置编码

位置编码把序列的顺序告诉模型。没有它，注意力机制看不出词的先后。
`

/** Asks one choice question, whose answer is the first option, and says the same thing to everything else. */
const model: ModelClient = {
  name: 'scripted',
  simulated: false,
  complete(messages: readonly ModelMessage[]) {
    const system = messages[0]?.content ?? ''
    if (system.includes('学习重点')) return Promise.resolve({ text: '{"focuses":["位置编码"]}' })
    if (system.includes('出练习题')) {
      return Promise.resolve({
        text: '{"kind":"choice","prompt":"位置编码告诉模型什么？","options":["顺序","颜色"],"answer":0,"excerpt":1}',
      })
    }
    return Promise.resolve({ text: '位置编码把序列的顺序告诉模型[1]。' })
  },
}

const SCENE = '/scene/workbench'
/** Not worded like the focus: a plan skips a focus the person already holds by that name. */
const HELD = '没有额外信号，注意力看不出词的先后'

let directory: string
let service: EpistemeService
let host: McpWire
let counter = 0

async function rest<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T & { code?: string } }> {
  const response = await fetch(`${service.apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.humanToken ?? ''}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as T & { code?: string } }
}

async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const answer = await host.call(name, args)
  expect(answer.isError ?? false, JSON.stringify(answer.structuredContent)).toBe(false)
  return answer.structuredContent as T
}

interface Objective {
  readonly id: string
  readonly label: string
  readonly candidates: readonly { readonly node?: string; readonly status: string }[]
}

interface Understanding {
  readonly nodes: readonly { readonly nodeId: string; readonly label: string }[]
  readonly pending: readonly {
    readonly id: string
    readonly rationale: string
    readonly state?: { readonly label: string; readonly dimension: string; readonly level: string }
  }[]
}

interface Reply {
  readonly plan: Plan
  readonly question?: PublicQuestion
}

/** A space with notes, and something the person holds in it that came from a candidate they accepted. */
async function aSpace(label = HELD): Promise<{ space: string; scope: string; node: string }> {
  const { space } = await ok<{ space: { id: string; scope: string } }>('learn_space_open', {
    submission: `sub-${++counter}`,
    name: '机器学习',
  })
  const added = await rest(`${SCENE}/materials`, {
    space: space.id,
    fileName: '笔记.md',
    contentBase64: Buffer.from(NOTES).toString('base64'),
  })
  expect(added.status).toBe(200)
  const { suggestion } = await ok<{ suggestion: { id: string } }>('propose', {
    kind: 'claim',
    label,
    rationale: '学习者自己这样说',
    scope: space.scope,
  })
  expect((await rest('/suggestions/decide', { id: suggestion.id, action: 'accept' })).status).toBe(
    200,
  )
  const [node] = (await understanding(space.id)).nodes
  expect(node?.label).toBe(label)
  return { space: space.id, scope: space.scope, node: node?.nodeId ?? '' }
}

/** One short plan on the page, up to its question, answered with the option given. */
async function practise(space: string, option: string): Promise<void> {
  const proposed = await rest<Reply>(`${SCENE}/plans`, {
    space,
    topic: '位置编码',
    minutes: 15,
    workflow: 'speedrun',
  })
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200)
  let reply = proposed.body
  for (let guard = 0; reply.question === undefined && guard < 10; guard += 1) {
    const action = guard === 0 ? 'begin' : 'next'
    const acted = await rest<Reply>(`${SCENE}/plans/act`, { plan: reply.plan.id, action })
    expect(acted.status, JSON.stringify(acted.body)).toBe(200)
    reply = acted.body
  }
  expect(reply.question?.kind).toBe('choice')
  const answered = await rest(`${SCENE}/plans/act`, {
    plan: reply.plan.id,
    action: 'answer',
    text: option,
  })
  expect(answered.status).toBe(200)
}

const understanding = async (space: string): Promise<Understanding> =>
  (await rest<Understanding>(`${SCENE}/understanding?space=${space}`)).body

const objectives = async (space: string): Promise<readonly Objective[]> =>
  (await rest<{ objectives: readonly Objective[] }>(`${SCENE}/outcomes?space=${space}`)).body
    .objectives

const link = (space: string, objective: string, node: string) =>
  rest<{ linked: boolean; objective?: Objective }>(`${SCENE}/objectives/link`, {
    space,
    objective,
    node,
  })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-practice-doubt-'))
  service = await startService({
    graph: join(directory, 'graph.db'),
    port: 0,
    profile: workbenchProfile({ model }),
  })
  host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
  counter = 0
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('a wrong answer on the page', () => {
  it('proposes nothing while the person has not said what the objective is about', async () => {
    const { space } = await aSpace()
    await practise(space, '1')
    expect((await understanding(space)).pending).toEqual([])
  })

  it('puts a doubt to the person once they have tied an understanding to the objective', async () => {
    const { space, node } = await aSpace()
    await practise(space, '0')
    const [objective] = await objectives(space)
    expect(objective?.label).toBe('位置编码')
    expect(objective?.candidates).toEqual([])

    const before = await understanding(space)
    const linked = await link(space, objective?.id ?? '', node)
    expect(linked.status).toBe(200)
    expect(linked.body.linked).toBe(true)
    expect(linked.body.objective?.candidates).toMatchObject([{ node, status: 'person' }])
    // Saying what an objective is about changes nothing the person holds.
    const tied = await understanding(space)
    expect([tied.nodes, tied.pending]).toEqual([before.nodes, before.pending])

    await practise(space, '1')
    const after = await understanding(space)
    expect(after.nodes).toEqual(before.nodes)
    expect(after.pending).toHaveLength(1)
    expect(after.pending[0]?.state).toEqual({ label: HELD, dimension: '冲突', level: '疑似' })
    expect(after.pending[0]?.rationale).toContain('这道题没答对（程序对照答案判定）')
    expect(after.pending[0]?.rationale).toContain('确认之前，你的理解不变')
    expect(after.pending[0]?.rationale).not.toContain('。。')
  })

  it('asks nothing after a right answer', async () => {
    const { space, node } = await aSpace()
    await practise(space, '0')
    const [objective] = await objectives(space)
    await link(space, objective?.id ?? '', node)
    await practise(space, '0')
    expect((await understanding(space)).pending).toEqual([])
  })
})

describe('tying an understanding to an objective', () => {
  it('ties it once', async () => {
    const { space, node } = await aSpace()
    await practise(space, '0')
    const [objective] = await objectives(space)
    expect((await link(space, objective?.id ?? '', node)).body.linked).toBe(true)
    const again = await link(space, objective?.id ?? '', node)
    expect(again.status).toBe(200)
    expect(again.body.linked).toBe(false)
    expect((await objectives(space))[0]?.candidates).toHaveLength(1)
  })

  it('refuses an objective or an understanding the space does not have', async () => {
    const { space, node } = await aSpace()
    await practise(space, '0')
    const [objective] = await objectives(space)
    const unknownObjective = await link(space, 'ob_nothing', node)
    expect([unknownObjective.status, unknownObjective.body.code]).toEqual([
      422,
      'unknown_objective',
    ])
    const unknownNode = await link(space, objective?.id ?? '', 'node_nothing')
    expect([unknownNode.status, unknownNode.body.code]).toEqual([422, 'unknown_node'])
  })
})

describe('a later plan', () => {
  /** Worded like the focus, so a plan counts the focus as already understood. */
  const LIKE_FOCUS = '位置编码把词的顺序告诉模型'

  const checks = async (space: string): Promise<readonly string[]> => {
    const { plan } = (
      await rest<Reply>(`${SCENE}/plans`, {
        space,
        topic: '位置编码',
        minutes: 15,
        workflow: 'speedrun',
      })
    ).body
    return plan.steps.filter((step) => step.block === 'check').map((step) => step.status)
  }

  /** The person records a conflict level on what they hold, the way accepting a doubt does. */
  async function record(at: { scope: string; node: string }, level: string): Promise<void> {
    const { suggestion } = await ok<{ suggestion: { id: string } }>('propose', {
      kind: 'state',
      target: at.node,
      dimension: 'conflict',
      level,
      rationale: '练习里没答对',
      scope: at.scope,
    })
    const decided = await rest('/suggestions/decide', { id: suggestion.id, action: 'accept' })
    expect(decided.status).toBe(200)
  }

  it('comes back to a focus the person has put under doubt, and skips it again once resolved', async () => {
    const at = await aSpace(LIKE_FOCUS)
    expect(await checks(at.space)).toEqual(['skipped'])

    await record(at, 'suspected')
    expect(await checks(at.space)).toEqual(['pending'])
    await record(at, 'open')
    expect(await checks(at.space)).toEqual(['pending'])

    await record(at, 'resolved')
    expect(await checks(at.space)).toEqual(['skipped'])
  })

  it('still skips while a doubt only waits for the person', async () => {
    const at = await aSpace(LIKE_FOCUS)
    await ok('propose', {
      kind: 'state',
      target: at.node,
      dimension: 'conflict',
      level: 'suspected',
      rationale: '练习里没答对',
      scope: at.scope,
    })
    expect(await checks(at.space)).toEqual(['skipped'])
  })
})
