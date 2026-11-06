import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SceneView } from '@episteme/application'
import { startService, type EpistemeService } from '@episteme/service'
import {
  evidenceOf,
  gapOf,
  objectiveIdOf,
  workbenchProfile,
  type LearningEvidence,
  type ModelClient,
} from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire, type McpWire, type ToolResult } from './mcp-wire.js'
import { storedText } from './stored.js'

/**
 * Learning run by a host agent (ADR 0019), spoken to over the wire as a host would. The service's model throws on any
 * call, so everything here that works, works with no model behind the service.
 */

const QUOTE = '校验和不对时跳过这条，继续恢复后面的'
const FOCUS = '中潮层崩溃重放'

const noModel: ModelClient = {
  name: 'none',
  simulated: false,
  complete: () => {
    throw new Error('the service called its model')
  },
}

let directory: string
let graph: string
let service: EpistemeService
let host: McpWire
let counter: number

const submission = (): string => `sub-${++counter}`

async function write(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return host.call(name, { submission: submission(), ...args })
}

/** What the tools answer, as far as these tests read it. */
interface SpaceShown {
  readonly id: string
  readonly scope: string
}

interface PlanShown {
  readonly id: string
  readonly version: number
  readonly status: string
  readonly steps: readonly {
    readonly id: string
    readonly objective: string
    readonly activity: string
    readonly status: string
  }[]
}

interface ReadingShown {
  readonly id: string
  readonly confirmation: string
  readonly wrongWords?: string | null
  readonly moves: readonly unknown[]
  readonly gap?: { readonly status: string; readonly diagnosis?: string }
}

interface ContextShown {
  readonly objectives: readonly ReadingShown[]
  readonly plans: readonly PlanShown[]
}

interface OutcomesShown {
  readonly objectives: readonly ReadingShown[]
  readonly sessions: readonly {
    readonly objectives: readonly { readonly events: readonly unknown[] }[]
  }[]
}

interface Spaced {
  readonly space: SpaceShown
}
interface Planned {
  readonly plan: PlanShown
}
interface Threaded {
  readonly thread: { readonly id: string }
}
interface Turned {
  readonly turn: { readonly id: string }
}
interface Suggested {
  readonly suggestion: { readonly id: string }
}

async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const answer = await host.call(name, args)
  expect(answer.isError ?? false, JSON.stringify(answer.structuredContent)).toBe(false)
  return answer.structuredContent as T
}

const made = <T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> => ok<T>(name, { submission: submission(), ...args })

function refused(answer: ToolResult, code: string): void {
  expect(answer.isError).toBe(true)
  expect(answer.structuredContent?.['code']).toBe(code)
}

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

interface Started {
  space: string
  scope: string
  thread: string
  plan: PlanShown
  objective: string
}

/** A space, a thread and a one-step plan on the focus. */
async function started(steps: readonly Record<string, unknown>[] = []): Promise<Started> {
  const { space } = await made<Spaced>('learn_space_open', { name: '潮汐缓存' })
  const { thread } = await ok<Threaded>('thread_open', { title: '第一天', scope: space.scope })
  const { plan } = await made<Planned>('learn_plan_start', {
    space: space.id,
    topic: '潮汐缓存协议',
    thread: thread.id,
    steps: steps.length > 0 ? steps : [{ activity: 'retell', label: FOCUS }],
  })
  return {
    space: space.id,
    scope: space.scope,
    thread: thread.id,
    plan,
    objective: plan.steps[0]?.objective ?? '',
  }
}

const learnerSays = async (thread: string, text: string): Promise<string> =>
  (await ok<Turned>('thread_append', { thread, speaker: 'learner', text })).turn.id

const enter = async (plan: PlanShown, step = plan.steps[0]?.id ?? '') =>
  (
    await made<Planned>('learn_step', {
      plan: plan.id,
      planVersion: plan.version,
      step,
      action: 'enter',
    })
  ).plan

const chooses = async (at: Started, plan: PlanShown, step?: string): Promise<void> => {
  await made('learn_observe', {
    plan: plan.id,
    planVersion: plan.version,
    objective: at.objective,
    kind: 'move',
    activity: 'retell',
    reason: '先让他自己说',
    ...(step === undefined ? {} : { step }),
  })
}

const attempt = async (
  at: Started,
  plan: PlanShown,
  words: string,
  verdict: string,
): Promise<void> => {
  const turn = await learnerSays(at.thread, words)
  await chooses(at, plan)
  await made('learn_observe', {
    plan: plan.id,
    planVersion: plan.version,
    objective: at.objective,
    kind: 'attempt',
    thread: at.thread,
    turn,
    quote: words,
    verdict,
    reason: '依据协议第三节',
    ...(verdict === 'contradicts' ? { diagnosis: '把校验失败当成可跳过' } : {}),
  })
}

const reading = async (space: string, objective: string): Promise<ReadingShown | undefined> =>
  (await ok<ContextShown>('learn_context', { space })).objectives.find(
    (each: { id: string }) => each.id === objective,
  )

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-host-learning-'))
  graph = join(directory, 'graph.db')
  service = await startService({ graph, port: 0, profile: workbenchProfile({ model: noModel }) })
  host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
  counter = 0
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

describe('answers a host can read as text', () => {
  it('carry the ids a host passes on, not only a summary sentence', async () => {
    const opened = await host.call('learn_space_open', {
      submission: submission(),
      name: '只读文字的宿主',
    })
    const { space } = opened.structuredContent as unknown as Spaced
    const listed = await host.call('learn_context', {})
    const threaded = await host.call('thread_open', { title: '文字', scope: space.scope })
    const { thread } = threaded.structuredContent as unknown as Threaded
    const text = (answer: typeof listed) =>
      answer.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    expect(text(opened)).toContain(space.id)
    expect(text(listed)).toContain(space.id)
    expect(text(threaded)).toContain(thread.id)
  })
})

describe('objectives', () => {
  it('are the same across spelling, and apart across spaces', () => {
    expect(objectiveIdOf('sp_a', '  中潮层   崩溃重放 ')).toBe(
      objectiveIdOf('sp_a', '中潮层 崩溃重放'),
    )
    expect(objectiveIdOf('sp_a', 'Replay')).toBe(objectiveIdOf('sp_a', 'ｒｅｐｌａｙ'))
    expect(objectiveIdOf('sp_a', 'replay')).not.toBe(objectiveIdOf('sp_b', 'replay'))
  })

  it('carry evidence from one plan and session to the next', async () => {
    const first = await started()
    const entered = await enter(first.plan)
    await attempt(first, entered, QUOTE, 'contradicts')

    host = mcpWire(() => service.mcpUrl, { name: 'A new session', version: '1' })
    const { spaces } = await ok<{ spaces: readonly { id: string }[] }>('learn_context', {})
    expect(spaces.map((space: { id: string }) => space.id)).toEqual([first.space])
    const context = await ok<ContextShown>('learn_context', { space: first.space })
    const [objective] = context.objectives
    expect(objective?.id).toBe(first.objective)
    expect(objective?.gap?.status).toBe('open')
    expect(objective?.gap?.diagnosis).toBe('把校验失败当成可跳过')
    expect(objective?.wrongWords).toBe(QUOTE)

    const { thread } = await ok<Threaded>('thread_open', { title: '第二天', scope: first.scope })
    const { plan } = await made<Planned>('learn_plan_start', {
      space: first.space,
      topic: '回到缺口',
      thread: thread.id,
      steps: [{ activity: 'probe', objective: objective?.id }],
    })
    expect(plan.steps[0]?.objective).toBe(first.objective)
  })
})

describe('what a gap says', () => {
  const evidence = (
    seq: number,
    verdict?: 'supports' | 'partial' | 'contradicts' | 'unclear',
  ): LearningEvidence => ({
    id: `e${seq}`,
    seq,
    at: seq,
    recordedBy: 'agent',
    space: 's',
    plan: 'p',
    objective: 'o',
    kind: 'attempt',
    ...(verdict === undefined
      ? {}
      : { assessment: { verdict, method: 'agent' as const, reason: 'r' } }),
  })

  it('does not exist until an attempt goes wrong', () => {
    expect(gapOf([evidence(1, 'supports'), evidence(2)])).toBeUndefined()
  })

  it('reads a later try as a retry unless it was judged to support', () => {
    const wrong = evidence(1, 'partial')
    expect(gapOf([wrong])).toMatchObject({ status: 'open', retries: 0 })
    expect(gapOf([wrong, evidence(2)])).toMatchObject({ status: 'retried', retries: 1 })
    expect(gapOf([wrong, evidence(2, 'unclear')])).toMatchObject({ status: 'retried', retries: 1 })
    expect(gapOf([wrong, evidence(2, 'supports')])).toMatchObject({
      status: 'supported',
      retries: 1,
      supportedBy: { method: 'agent', recordedBy: 'agent' },
    })
  })

  it('opens again on a later wrong attempt, and has no state meaning it is over', () => {
    const gap = gapOf([evidence(1, 'contradicts'), evidence(2, 'supports'), evidence(3, 'partial')])
    expect(gap).toMatchObject({ status: 'open', retries: 2, wrong: 'e3', openedAt: 1 })
    expect(gap?.supportedBy).toBeUndefined()
  })

  it('is read in order, whatever order the records come in', () => {
    expect(gapOf([evidence(2, 'supports'), evidence(1, 'contradicts')])?.status).toBe('supported')
  })
})

describe('confirmation stays the person’s', () => {
  const candidate = async (at: Started, plan: PlanShown): Promise<string> => {
    const { suggestion } = await ok<Suggested>('propose', {
      kind: 'claim',
      label: '校验和不对时必须停止恢复',
      rationale: '学习者第二次这样说',
      scope: at.scope,
    })
    await made('learn_observe', {
      plan: plan.id,
      planVersion: plan.version,
      objective: at.objective,
      kind: 'candidate',
      suggestion: suggestion.id,
    })
    return suggestion.id
  }

  it('is not changed by a supported gap, and reads apart from it', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    await attempt(at, plan, QUOTE, 'contradicts')
    await attempt(at, plan, '校验和不对就停下', 'supports')

    const objective = await reading(at.space, at.objective)
    expect(objective?.gap?.status).toBe('supported')
    expect(objective?.confirmation).toBe('none')
    expect(JSON.stringify(objective)).not.toMatch(/mastered|mastery/)
  })

  it('moves from pending to the person only when they decide over REST', async () => {
    const at = await started()
    const id = await candidate(at, await enter(at.plan))
    expect((await reading(at.space, at.objective))?.confirmation).toBe('pending')

    const decided = await rest('/suggestions/decide', { id, action: 'accept' })
    expect(decided.status).toBe(200)
    expect((await reading(at.space, at.objective))?.confirmation).toBe('person')
  })

  it('reads a delegated acceptance as delegated, not as the person’s own', async () => {
    const at = await started()
    expect((await rest('/delegations', { scope: at.scope })).status).toBe(200)
    await candidate(at, await enter(at.plan))
    const objective = await reading(at.space, at.objective)
    expect(objective?.confirmation).toBe('delegated')
  })

  it('goes back to none when the person dismisses it', async () => {
    const at = await started()
    const id = await candidate(at, await enter(at.plan))
    await rest('/suggestions/decide', { id, action: 'dismiss' })
    expect((await reading(at.space, at.objective))?.confirmation).toBe('none')
  })

  it('offers an agent no tool that can confirm', async () => {
    const { body } = await host.rpc('tools/list', {})
    const names = ((body['result'] as { tools: { name: string }[] }).tools ?? []).map(
      (tool) => tool.name,
    )
    expect(names.filter((name) => name.startsWith('learn_')).sort()).toEqual([
      'learn_context',
      'learn_observe',
      'learn_plan_change',
      'learn_plan_start',
      'learn_space_open',
      'learn_step',
    ])
    expect(names.some((name) => /decide|confirm|accept/.test(name))).toBe(false)
  })
})

describe('what the record refuses', () => {
  it('a step entered out of turn, or twice', async () => {
    const at = await started([
      { activity: 'retell', label: FOCUS },
      { activity: 'probe', label: FOCUS },
    ])
    const later = at.plan.steps[1]?.id
    refused(
      await write('learn_step', {
        plan: at.plan.id,
        planVersion: 1,
        step: later,
        action: 'enter',
      }),
      'invalid_transition',
    )
    const plan = await enter(at.plan)
    refused(
      await write('learn_step', {
        plan: plan.id,
        planVersion: plan.version,
        step: later,
        action: 'enter',
      }),
      'invalid_transition',
    )
  })

  it('a step completed with nothing the learner did on it, and one not open', async () => {
    const at = await started()
    const step = at.plan.steps[0]?.id
    refused(
      await write('learn_step', { plan: at.plan.id, planVersion: 1, step, action: 'complete' }),
      'invalid_transition',
    )
    const plan = await enter(at.plan)
    refused(
      await write('learn_step', {
        plan: plan.id,
        planVersion: plan.version,
        step,
        action: 'complete',
      }),
      'no_evidence',
    )
    await made('learn_observe', {
      plan: plan.id,
      planVersion: plan.version,
      objective: at.objective,
      kind: 'move',
      activity: 'retell',
      reason: '先让他说',
      step,
    })
    refused(
      await write('learn_step', {
        plan: plan.id,
        planVersion: plan.version,
        step,
        action: 'complete',
      }),
      'no_evidence',
    )
  })

  it('counts evidence that names no step toward the open step on its objective', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    await attempt(at, plan, QUOTE, 'contradicts')
    const { plan: closed } = await made<Planned>('learn_step', {
      plan: plan.id,
      planVersion: plan.version,
      step: at.plan.steps[0]?.id,
      action: 'complete',
    })
    expect(closed.status).toBe('done')
  })

  it('finishes a plan when no step remains, and then takes no more writes', async () => {
    const at = await started()
    const step = at.plan.steps[0]?.id
    const plan = await enter(at.plan)
    const turn = await learnerSays(at.thread, QUOTE)
    await chooses(at, plan, step)
    await made('learn_observe', {
      plan: plan.id,
      planVersion: plan.version,
      objective: at.objective,
      kind: 'attempt',
      step,
      thread: at.thread,
      turn,
      quote: QUOTE,
    })
    const { plan: closed } = await made<Planned>('learn_step', {
      plan: plan.id,
      planVersion: plan.version,
      step,
      action: 'complete',
    })
    expect(closed.status).toBe('done')
    refused(
      await write('learn_observe', {
        plan: plan.id,
        planVersion: closed.version,
        objective: at.objective,
        kind: 'move',
        activity: 'retell',
        reason: 'r',
      }),
      'plan_done',
    )
  })

  it('a skip with no reason, leaving the step as it was', async () => {
    const at = await started()
    const answer = await write('learn_step', {
      plan: at.plan.id,
      planVersion: 1,
      step: at.plan.steps[0]?.id,
      action: 'skip',
    })
    expect(answer.isError).toBe(true)
    const { plans } = await ok<ContextShown>('learn_context', { space: at.space })
    expect(plans[0]?.steps[0]?.status).toBe('pending')
  })

  it('a version that has moved on', async () => {
    const at = await started()
    await enter(at.plan)
    refused(
      await write('learn_observe', {
        plan: at.plan.id,
        planVersion: 1,
        objective: at.objective,
        kind: 'move',
        activity: 'retell',
        reason: 'r',
      }),
      'version_conflict',
    )
  })

  it('a submission reused for something else, and repeats nothing when sent again', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    const args = {
      submission: 'mine',
      plan: plan.id,
      planVersion: plan.version,
      objective: at.objective,
      kind: 'move',
      activity: 'retell',
      reason: '先让他说',
    }
    expect((await host.call('learn_observe', args)).isError ?? false).toBe(false)
    const again = await host.call('learn_observe', args)
    expect(again.structuredContent?.['replayed']).toBe(true)
    const objective = await reading(at.space, at.objective)
    expect(objective?.moves).toHaveLength(1)
    refused(
      await host.call('learn_observe', { ...args, reason: '另一个理由' }),
      'submission_conflict',
    )
  })

  it('one write at a time: two steps entered at once cannot both pass', async () => {
    const at = await started()
    const send = (id: string) =>
      host.call('learn_step', {
        submission: id,
        plan: at.plan.id,
        planVersion: 1,
        step: at.plan.steps[0]?.id,
        action: 'enter',
      })
    const answers = await Promise.all([send('a'), send('b')])
    expect(answers.filter((answer) => answer.isError === true)).toHaveLength(1)
    refused(answers.find((answer) => answer.isError === true) ?? {}, 'version_conflict')
  })

  it('words the learner did not say', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    const turn = await learnerSays(at.thread, QUOTE)
    const base = {
      plan: plan.id,
      planVersion: plan.version,
      objective: at.objective,
      kind: 'attempt',
      thread: at.thread,
    }
    refused(await write('learn_observe', { ...base, turn, quote: '并没有说过' }), 'quote_not_found')
    const { turn: mine } = await ok<Turned>('thread_append', {
      thread: at.thread,
      speaker: 'agent',
      text: '校验和不对时要停下',
    })
    refused(
      await write('learn_observe', { ...base, turn: mine.id, quote: '校验和不对时要停下' }),
      'quote_not_found',
    )
  })

  it('a thread of another space, for evidence and for a plan', async () => {
    const at = await started()
    const { space: other } = await made<Spaced>('learn_space_open', { name: '另一个空间' })
    const { thread: elsewhere } = await ok<Threaded>('thread_open', {
      title: '别处',
      scope: other.scope,
    })
    const turn = await learnerSays(elsewhere.id, QUOTE)
    const plan = await enter(at.plan)
    refused(
      await write('learn_observe', {
        plan: plan.id,
        planVersion: plan.version,
        objective: at.objective,
        kind: 'attempt',
        thread: elsewhere.id,
        turn,
        quote: QUOTE,
      }),
      'thread_outside_space',
    )
    refused(
      await write('learn_plan_start', {
        space: at.space,
        topic: 't',
        thread: elsewhere.id,
        steps: [{ activity: 'retell', label: FOCUS }],
      }),
      'thread_outside_space',
    )
  })

  it('an objective of another space, or another step', async () => {
    const at = await started([
      { activity: 'retell', label: FOCUS },
      { activity: 'probe', label: '涨潮条件和翻倍上限' },
    ])
    const plan = await enter(at.plan)
    refused(
      await write('learn_observe', {
        plan: plan.id,
        planVersion: plan.version,
        objective: objectiveIdOf('elsewhere', FOCUS),
        kind: 'move',
        activity: 'retell',
        reason: 'r',
      }),
      'objective_outside_plan',
    )
    refused(
      await write('learn_observe', {
        plan: plan.id,
        planVersion: plan.version,
        objective: at.objective,
        step: plan.steps[1]?.id,
        kind: 'move',
        activity: 'retell',
        reason: 'r',
      }),
      'objective_outside_plan',
    )
  })

  it('a suggestion it does not know, or of another space', async () => {
    const at = await started()
    const { space: other } = await made<Spaced>('learn_space_open', { name: '另一个空间' })
    const { suggestion } = await ok<Suggested>('propose', {
      kind: 'claim',
      label: '别处的说法',
      rationale: 'r',
      scope: other.scope,
    })
    const plan = await enter(at.plan)
    for (const id of ['su_nothing', suggestion.id]) {
      refused(
        await write('learn_observe', {
          plan: plan.id,
          planVersion: plan.version,
          objective: at.objective,
          kind: 'candidate',
          suggestion: id,
        }),
        'unknown_suggestion',
      )
    }
  })

  it('an activity the library does not have', async () => {
    const at = await started()
    refused(
      await write('learn_plan_change', {
        plan: at.plan.id,
        planVersion: 1,
        add: [{ activity: 'nothing', objective: at.objective }],
      }),
      'unknown_block',
    )
  })

  it('a host plan driven from the page, and a page plan driven by a host', async () => {
    const at = await started()
    const acted = await rest<{ code: string }>('/scene/workbench/plans/act', {
      plan: at.plan.id,
      action: 'enter',
    })
    expect(acted.body.code).toBe('host_driven')
  })
})

describe('changing a plan', () => {
  it('puts new steps right after what is open, and leaves what happened', async () => {
    const at = await started([
      { activity: 'retell', label: FOCUS },
      { activity: 'summary', label: FOCUS },
    ])
    const plan = await enter(at.plan)
    const { plan: changed } = await made<Planned>('learn_plan_change', {
      plan: plan.id,
      planVersion: plan.version,
      add: [{ activity: 'probe', objective: at.objective }],
      position: 'next',
      skip: [{ step: plan.steps[1]?.id, reason: '不需要总结' }],
    })
    expect(changed.steps.map((step: { activity: string }) => step.activity)).toEqual([
      'retell',
      'probe',
      'summary',
    ])
    expect(changed.steps[0]?.status).toBe('active')
    expect(changed.steps[2]).toMatchObject({ status: 'skipped', note: '不需要总结' })
    expect(changed.version).toBe(plan.version + 1)
  })

  it('refuses to skip a step already under way, and an empty change', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    refused(
      await write('learn_plan_change', {
        plan: plan.id,
        planVersion: plan.version,
        skip: [{ step: plan.steps[0]?.id, reason: 'r' }],
      }),
      'invalid_transition',
    )
    refused(
      await write('learn_plan_change', { plan: plan.id, planVersion: plan.version }),
      'invalid_request',
    )
  })
})

describe('an attempt needs the choice behind it', () => {
  const answers = async (at: Started, plan: PlanShown, verdict?: string) => {
    const turn = await learnerSays(at.thread, QUOTE)
    return write('learn_observe', {
      plan: plan.id,
      planVersion: plan.version,
      objective: at.objective,
      kind: 'attempt',
      thread: at.thread,
      turn,
      quote: QUOTE,
      ...(verdict === undefined ? {} : { verdict, reason: '依据第三节' }),
    })
  }

  it('the first time, and again after an answer not judged to support', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    refused(await answers(at, plan, 'contradicts'), 'no_move')
    expect(await reading(at.space, at.objective)).toMatchObject({ attempts: 0 })

    await chooses(at, plan)
    expect((await answers(at, plan, 'contradicts')).isError ?? false).toBe(false)
    refused(await answers(at, plan, 'supports'), 'no_move')

    await chooses(at, plan)
    expect((await answers(at, plan)).isError ?? false).toBe(false)
    refused(await answers(at, plan, 'supports'), 'no_move')
  })

  it('not after one judged to support, and not for a statement', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    await chooses(at, plan)
    expect((await answers(at, plan, 'supports')).isError ?? false).toBe(false)
    expect((await answers(at, plan, 'supports')).isError ?? false).toBe(false)

    const other = await started([{ activity: 'retell', label: '另一个点' }])
    const turn = await learnerSays(other.thread, QUOTE)
    await made('learn_observe', {
      plan: other.plan.id,
      planVersion: other.plan.version,
      objective: other.objective,
      kind: 'statement',
      thread: other.thread,
      turn,
      quote: QUOTE,
    })
  })

  it('reads the words before the choice, so an invented quote still says so', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    const turn = await learnerSays(at.thread, QUOTE)
    refused(
      await write('learn_observe', {
        plan: plan.id,
        planVersion: plan.version,
        objective: at.objective,
        kind: 'attempt',
        thread: at.thread,
        turn,
        quote: '他没说过的话',
      }),
      'quote_not_found',
    )
  })
})

describe('a suggestion tied to no objective', () => {
  const proposes = async (at: Started): Promise<string> =>
    (
      await ok<Suggested>('propose', {
        kind: 'claim',
        label: '校验和不对时必须停止恢复',
        rationale: '学习者这样说',
        scope: at.scope,
      })
    ).suggestion.id

  it('is pointed out until it is tied, and counted for the page', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    const suggestion = await proposes(at)
    const listed = await ok<{ unlinked: readonly { suggestion: string; label: string }[] }>(
      'learn_context',
      { space: at.space },
    )
    expect(listed.unlinked).toEqual([{ suggestion, label: '校验和不对时必须停止恢复' }])

    const noted = await write('learn_observe', {
      plan: plan.id,
      planVersion: plan.version,
      objective: at.objective,
      kind: 'move',
      activity: 'retell',
      reason: 'r',
    })
    expect(JSON.stringify(noted.structuredContent)).toContain(suggestion)
    const page = await rest<{ unlinked: number }>(`/scene/workbench/outcomes?space=${at.space}`)
    expect(page.body.unlinked).toBe(1)

    const tied = await write('learn_observe', {
      plan: plan.id,
      planVersion: plan.version,
      objective: at.objective,
      kind: 'candidate',
      suggestion,
    })
    expect(JSON.stringify(tied.structuredContent)).not.toContain('unlinked')
    const after = await rest<{ unlinked: number }>(`/scene/workbench/outcomes?space=${at.space}`)
    expect(after.body.unlinked).toBe(0)
  })

  it('can still be tied after the plan has finished, which nothing else can', async () => {
    const at = await started()
    const step = at.plan.steps[0]?.id
    const plan = await enter(at.plan)
    const turn = await learnerSays(at.thread, QUOTE)
    await made('learn_observe', {
      plan: plan.id,
      planVersion: plan.version,
      objective: at.objective,
      kind: 'statement',
      step,
      thread: at.thread,
      turn,
      quote: QUOTE,
    })
    const suggestion = await proposes(at)
    const { plan: closed } = await made<Planned>('learn_step', {
      plan: plan.id,
      planVersion: plan.version,
      step,
      action: 'complete',
    })
    expect(closed.status).toBe('done')
    await made('learn_observe', {
      plan: plan.id,
      planVersion: closed.version,
      objective: at.objective,
      kind: 'candidate',
      suggestion,
    })
    expect(await reading(at.space, at.objective)).toMatchObject({ confirmation: 'pending' })
  })

  it('cannot be a link: an objective is about claims, and a link has no words to show', async () => {
    const at = await started()
    const words = '校验和不对就停下。后面的记录丢弃。'
    const distilled = await ok<{
      suggestions: readonly { id: string; proposal: { kind: string } }[]
    }>('distill', {
      title: '第三节',
      text: words,
      scope: at.scope,
      candidates: [
        {
          kind: 'node',
          ref: 'a',
          role: 'claim',
          label: '校验和不对就停下',
          quote: '校验和不对就停下',
          basis: 'inferred',
          rationale: 'r',
        },
        {
          kind: 'node',
          ref: 'b',
          role: 'claim',
          label: '后面的记录丢弃',
          quote: '后面的记录丢弃',
          basis: 'inferred',
          rationale: 'r',
        },
        {
          kind: 'relation',
          ref: 'c',
          relation: 'revises',
          from: 'cand:b',
          to: 'cand:a',
          quote: '后面的记录丢弃',
          basis: 'inferred',
          rationale: 'r',
        },
      ],
    })
    const link = distilled.suggestions.find((each) => each.proposal.kind === 'link')
    expect(link, JSON.stringify(distilled)).toBeDefined()
    refused(
      await write('learn_observe', {
        plan: at.plan.id,
        planVersion: at.plan.version,
        objective: at.objective,
        kind: 'candidate',
        suggestion: link?.id,
      }),
      'invalid_evidence',
    )
  })

  it('still becomes the person’s when they confirm it, on no objective', async () => {
    const at = await started()
    const suggestion = await proposes(at)
    await rest('/suggestions/decide', { id: suggestion, action: 'accept' })
    expect((await reading(at.space, at.objective))?.confirmation).toBe('none')
    const page = await rest<{ unlinked: number }>(`/scene/workbench/outcomes?space=${at.space}`)
    expect(page.body.unlinked).toBe(0)
  })
})

describe('what the page reads', () => {
  it('shows sessions and objectives with no words of a turn', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    await attempt(at, plan, QUOTE, 'contradicts')
    const { status, body } = await rest<OutcomesShown>(
      `/scene/workbench/outcomes?space=${at.space}`,
    )
    expect(status).toBe(200)
    expect(JSON.stringify(body)).not.toContain(QUOTE)
    expect(body.objectives[0]?.gap?.status).toBe('open')
    const [session] = body.sessions
    expect(session).toMatchObject({ topic: '潮汐缓存协议', origin: 'host', thread: at.thread })
    expect(session?.objectives[0]?.events[0]).toMatchObject({ kind: 'move' })
    expect(session?.objectives[0]?.events[1]).toMatchObject({
      kind: 'attempt',
      assessment: { verdict: 'contradicts', method: 'agent' },
    })
  })

  it('reads a page plan’s answers as evidence, marked by who judged them', () => {
    const records = new Map<string, unknown>([
      ['plan/p', { id: 'p', space: 's', origin: 'outline', steps: [], thread: 't', createdAt: 1 }],
      [
        'attempt/checked',
        {
          id: 'checked',
          plan: 'p',
          step: 'x',
          focus: FOCUS,
          question: { prompt: 'q1' },
          correct: false,
          answeredAt: 1,
        },
      ],
      [
        'attempt/judged',
        {
          id: 'judged',
          plan: 'p',
          step: 'y',
          focus: FOCUS,
          question: { prompt: 'q2' },
          estimate: 'correct',
          answeredAt: 2,
        },
      ],
      [
        'attempt/waiting',
        { id: 'waiting', plan: 'p', step: 'z', focus: FOCUS, question: { prompt: 'q3' } },
      ],
    ])
    const view = {
      records: {
        list: (prefix: string) =>
          [...records]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value })),
      },
    } as unknown as SceneView
    const read = evidenceOf(view, 's')
    expect(read.map((each) => each.assessment?.method)).toEqual(['mechanical', 'model'])
    expect(read[0]?.objective).toBe(objectiveIdOf('s', FOCUS))
    expect(gapOf(read)).toMatchObject({ status: 'supported', supportedBy: { method: 'model' } })
  })

  it('lets a person pause a host plan, but not change its steps', async () => {
    const at = await started()
    const edited = await rest<{ code: string }>('/scene/workbench/plans/update', {
      plan: at.plan.id,
      steps: [],
    })
    expect(edited.body.code).toBe('host_driven')
    const paused = await rest('/scene/workbench/plans/update', {
      plan: at.plan.id,
      status: 'paused',
    })
    expect(paused.status).toBe(200)
    refused(
      await write('learn_step', {
        plan: at.plan.id,
        planVersion: 1,
        step: at.plan.steps[0]?.id,
        action: 'enter',
      }),
      'plan_paused',
    )
  })
})

describe('where the words are', () => {
  it('keeps them in the thread: evidence holds a pointer and a digest', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    await attempt(at, plan, QUOTE, 'contradicts')
    await service.close()
    const scene = storedText(graph, 'scene-records')
    expect(scene).toContain('"kind":"attempt"')
    expect(scene).not.toContain(QUOTE)
    service = await startService({ graph, port: 0, profile: workbenchProfile({ model: noModel }) })
  })

  it('survives a restart with the gap as it was', async () => {
    const at = await started()
    const plan = await enter(at.plan)
    await attempt(at, plan, QUOTE, 'contradicts')
    await service.close()
    service = await startService({ graph, port: 0, profile: workbenchProfile({ model: noModel }) })
    const objective = await reading(at.space, at.objective)
    expect(objective?.gap?.status).toBe('open')
    expect(objective?.wrongWords).toBe(QUOTE)
  })
})
