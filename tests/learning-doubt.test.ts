import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CognitiveSession } from '@episteme/application'
import { type EpistemeService, startService } from '@episteme/service'
import { type ModelClient, workbenchProfile } from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type McpWire, mcpWire } from './mcp-wire.js'

/**
 * An attempt that falls short puts a doubt to the person about what they hold on its objective (a negotiated learner
 * model): one pending change, `conflict: suspected`, per held node. The evidence proposes, the person decides; until
 * then nothing they hold changes, and an agent has no way to decide it for them.
 */

const noModel: ModelClient = {
  name: 'none',
  simulated: false,
  complete: () => {
    throw new Error('the service called its model')
  },
}

const SCENE = '/scene/workbench'
const HELD = '校验和不对时必须停止恢复'

let directory: string
let graph: string
let service: EpistemeService
let open = false
let host: McpWire
let counter = 0

const submission = (): string => `sub-${++counter}`

async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const answer = await host.call(name, args)
  expect(answer.isError ?? false, JSON.stringify(answer.structuredContent)).toBe(false)
  return answer.structuredContent as T
}

const made = <T = Record<string, unknown>>(name: string, args: Record<string, unknown>) =>
  ok<T>(name, { submission: submission(), ...args })

async function rest<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${service.apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.humanToken ?? ''}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as T }
}

interface Plan {
  readonly id: string
  readonly version: number
  readonly steps: readonly { readonly id: string; readonly objective: string }[]
}

interface Understanding {
  readonly nodes: readonly {
    readonly nodeId: string
    readonly label: string
    readonly understanding: readonly { readonly id: string; readonly level: string }[]
  }[]
  readonly pending: readonly {
    readonly id: string
    readonly proposal: { readonly kind: string; readonly target?: string }
    readonly rationale: string
    readonly state?: { readonly label: string; readonly dimension: string; readonly level: string }
  }[]
}

interface Learning {
  readonly space: string
  readonly scope: string
  readonly thread: string
  readonly plan: Plan
  readonly objective: string
}

/** A space with a one-step plan, entered, and a claim on its objective that the person has decided on. */
async function learning(options: { delegate?: boolean } = {}): Promise<Learning> {
  const { space } = await made<{ space: { id: string; scope: string } }>('learn_space_open', {
    name: '潮汐缓存',
  })
  if (options.delegate === true) {
    expect((await rest('/delegations', { scope: space.scope })).status).toBe(200)
  }
  const { thread } = await ok<{ thread: { id: string } }>('thread_open', {
    title: '第一天',
    scope: space.scope,
  })
  const started = await made<{ plan: Plan }>('learn_plan_start', {
    space: space.id,
    topic: '潮汐缓存协议',
    thread: thread.id,
    steps: [{ activity: 'retell', label: '中潮层崩溃重放' }],
  })
  const { plan } = await made<{ plan: Plan }>('learn_step', {
    plan: started.plan.id,
    planVersion: started.plan.version,
    step: started.plan.steps[0]?.id,
    action: 'enter',
  })
  const objective = plan.steps[0]?.objective ?? ''
  const { suggestion } = await ok<{ suggestion: { id: string } }>('propose', {
    kind: 'claim',
    label: HELD,
    rationale: '学习者自己这样说',
    scope: space.scope,
  })
  await made('learn_observe', {
    plan: plan.id,
    planVersion: plan.version,
    objective,
    kind: 'candidate',
    suggestion: suggestion.id,
  })
  if (options.delegate !== true) {
    expect(
      (await rest('/suggestions/decide', { id: suggestion.id, action: 'accept' })).status,
    ).toBe(200)
  }
  return { space: space.id, scope: space.scope, thread: thread.id, plan, objective }
}

/** The learner answers, and the agent records how the answer went. Returns what the record proposed. */
async function answers(at: Learning, words: string, verdict: string): Promise<readonly string[]> {
  const { turn } = await ok<{ turn: { id: string } }>('thread_append', {
    thread: at.thread,
    speaker: 'learner',
    text: words,
  })
  const base = { plan: at.plan.id, planVersion: at.plan.version, objective: at.objective }
  await made('learn_observe', { ...base, kind: 'move', activity: 'retell', reason: '先让他自己说' })
  const recorded = await made<{ proposed?: readonly string[] }>('learn_observe', {
    ...base,
    kind: 'attempt',
    thread: at.thread,
    turn: turn.id,
    quote: words,
    verdict,
    reason: '依据协议第三节',
    ...(verdict === 'contradicts' ? { diagnosis: '把校验失败当成可跳过' } : {}),
  })
  return recorded.proposed ?? []
}

const understanding = async (at: Learning): Promise<Understanding> =>
  (await rest<Understanding>(`${SCENE}/understanding?space=${at.space}`)).body

const conflictOf = (read: Understanding, nodeId: string): string | undefined =>
  read.nodes.find((node) => node.nodeId === nodeId)?.understanding.find((d) => d.id === 'conflict')
    ?.level

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-learning-doubt-'))
  graph = join(directory, 'graph.db')
  service = await startService({ graph, port: 0, profile: workbenchProfile({ model: noModel }) })
  open = true
  host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
  counter = 0
})

afterEach(async () => {
  if (open) await service.close()
  open = false
  await rm(directory, { recursive: true, force: true })
})

describe('an attempt that falls short', () => {
  it('asks the person whether what they hold still stands, and changes nothing yet', async () => {
    const at = await learning()
    const before = await understanding(at)
    const [held] = before.nodes
    expect(held?.label).toBe(HELD)

    const proposed = await answers(at, '校验和不对时跳过这条，继续恢复后面的', 'contradicts')
    expect(proposed).toHaveLength(1)

    const after = await understanding(at)
    expect(after.nodes).toEqual(before.nodes)
    expect(after.pending).toHaveLength(1)
    const [waiting] = after.pending
    expect(waiting?.id).toBe(proposed[0])
    expect(waiting?.proposal).toMatchObject({ kind: 'state', target: held?.nodeId })
    expect(waiting?.state).toEqual({ label: HELD, dimension: '冲突', level: '疑似' })
    expect(after.pending[0]?.rationale).toContain('没答对')
    expect(after.pending[0]?.rationale).toContain('确认之前，你的理解不变')
  })

  it('becomes the person’s, confirmed by them, only when they accept it', async () => {
    const at = await learning()
    const [held] = (await understanding(at)).nodes
    const [id] = await answers(at, '只记得要校验，不知道失败时怎么办', 'partial')

    expect((await rest('/suggestions/decide', { id, action: 'accept' })).status).toBe(200)
    expect(conflictOf(await understanding(at), held?.nodeId ?? '')).toBe('suspected')

    await service.close()
    open = false
    const session = await CognitiveSession.open({ filePath: graph })
    try {
      const last = session.historyOf(held?.nodeId ?? '')?.at(-1)
      expect(last?.dimensions).toEqual([
        ['conflict', expect.objectContaining({ level: 'suspected', authority: 'confirmed' })],
      ])
    } finally {
      await session.close()
    }
  })

  it('leaves what they hold as it was when they disagree', async () => {
    const at = await learning()
    const [held] = (await understanding(at)).nodes
    const [id] = await answers(at, '校验和不对时跳过这条', 'contradicts')
    expect((await rest('/suggestions/decide', { id, action: 'dismiss' })).status).toBe(200)
    const after = await understanding(at)
    expect(conflictOf(after, held?.nodeId ?? '')).toBeUndefined()
    expect(after.pending).toEqual([])
  })

  it('asks once: not again while it waits, nor once the doubt is held', async () => {
    const at = await learning()
    const [id] = await answers(at, '校验和不对时跳过这条', 'contradicts')
    expect(await answers(at, '还是跳过吧', 'contradicts')).toEqual([])
    expect((await understanding(at)).pending).toHaveLength(1)

    await rest('/suggestions/decide', { id, action: 'accept' })
    expect(await answers(at, '跳过', 'partial')).toEqual([])
    expect((await understanding(at)).pending).toEqual([])
  })

  it('still waits for the person under a delegation, which never picks a side (ADR 0016)', async () => {
    const at = await learning({ delegate: true })
    const [held] = (await understanding(at)).nodes
    // The claim itself was accepted under the delegation; the doubt about it is not.
    expect(held?.label).toBe(HELD)
    const [id] = await answers(at, '校验和不对时跳过这条', 'contradicts')
    const after = await understanding(at)
    expect(after.pending.map((each) => each.id)).toEqual([id])
    expect(conflictOf(after, held?.nodeId ?? '')).toBeUndefined()
  })
})

describe('an attempt that does not fall short', () => {
  it('proposes nothing when it supports or is unclear', async () => {
    const at = await learning()
    expect(await answers(at, '校验和不对就停下', 'supports')).toEqual([])
    expect(await answers(at, '嗯……', 'unclear')).toEqual([])
    expect((await understanding(at)).pending).toEqual([])
  })

  it('proposes nothing on an objective the person holds nothing about', async () => {
    const { space } = await made<{ space: { id: string; scope: string } }>('learn_space_open', {
      name: '空的',
    })
    const { thread } = await ok<{ thread: { id: string } }>('thread_open', {
      title: '第一天',
      scope: space.scope,
    })
    const started = await made<{ plan: Plan }>('learn_plan_start', {
      space: space.id,
      topic: '空',
      thread: thread.id,
      steps: [{ activity: 'retell', label: '还没有理解的目标' }],
    })
    const { plan } = await made<{ plan: Plan }>('learn_step', {
      plan: started.plan.id,
      planVersion: started.plan.version,
      step: started.plan.steps[0]?.id,
      action: 'enter',
    })
    const at = {
      space: space.id,
      scope: space.scope,
      thread: thread.id,
      plan,
      objective: plan.steps[0]?.objective ?? '',
    }
    expect(await answers(at, '不知道', 'contradicts')).toEqual([])
  })
})
