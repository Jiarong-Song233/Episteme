import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type EpistemeService } from '@episteme/service'
import {
  BUILT_IN_LIBRARY,
  checkAnswer,
  clozeFrom,
  estimateFrom,
  libraryProblems,
  ModelFailure,
  reviewSuggestions,
  SimulatedModel,
  checkReply,
  workbenchProfile,
  type Answer,
  type Attempt,
  type Library,
  type ModelClient,
  type ModelMessage,
  type Plan,
  type PublicQuestion,
  type Question,
  type SearchHit,
  type Space,
} from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const NOTES = `# Transformer 笔记

## 位置编码

位置编码把序列的顺序告诉模型。没有它，注意力机制看不出词的先后。

## 自注意力

自注意力让每个词根据其他词调整自己的表示。它计算查询和键的相似度，再对值加权。

## 多头注意力

多头注意力并行运行多组注意力，让模型同时关注不同的关系。
`

interface Reply<T> {
  readonly status: number
  readonly body: T & { readonly code?: string; readonly error?: string }
}

interface PlanReply {
  readonly plan: Plan
  readonly notice?: string
  readonly question?: PublicQuestion
  readonly failure?: { readonly code: string; readonly retryable: boolean }
}

interface Turn {
  readonly speaker: string
  readonly text: string
  readonly by?: string
  readonly answer?: Answer
}

/** A model that answers by what it is asked for, and fails on demand. */
class ScriptedModel implements ModelClient {
  readonly name = 'scripted'
  readonly simulated = false
  readonly calls: (readonly ModelMessage[])[] = []
  failing = false
  question =
    '{"kind":"choice","prompt":"位置编码告诉模型什么？","options":["顺序","颜色"],"answer":0,"excerpt":1}'
  reply = '位置编码把序列的顺序告诉模型[1]。你觉得没有它会怎样？'

  complete(messages: readonly ModelMessage[]) {
    this.calls.push(messages)
    if (this.failing) {
      return Promise.reject(new ModelFailure('timeout', '模型超时了。'))
    }
    const system = messages[0]?.content ?? ''
    if (system.includes('学习重点')) {
      return Promise.resolve({ text: '{"focuses":["位置编码","自注意力","月球的引力"]}' })
    }
    if (system.includes('出练习题')) return Promise.resolve({ text: this.question })
    return Promise.resolve({ text: this.reply })
  }
}

let directory: string
let graph: string
let service: EpistemeService
let running = false

const scene = '/scene/workbench'

const start = async (
  model: ModelClient = new SimulatedModel(),
  options: { library?: Library; now?: () => number } = {},
): Promise<void> => {
  service = await startService({
    graph,
    port: 0,
    profile: workbenchProfile({ model, ...options }),
  })
  running = true
}

async function call<T = Record<string, unknown>>(path: string, body?: unknown): Promise<Reply<T>> {
  const response = await fetch(`${service.apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.humanToken ?? ''}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as Reply<T>['body'] }
}

async function spaceWithNotes(): Promise<Space> {
  const { space } = (await call<{ space: Space }>(`${scene}/spaces`, { name: '机器学习' })).body
  await call(`${scene}/materials`, {
    space: space.id,
    fileName: '笔记.md',
    contentBase64: Buffer.from(NOTES).toString('base64'),
  })
  return space
}

const propose = async (space: Space, workflow: string, minutes = 60, topic = 'Transformer') =>
  (await call<PlanReply>(`${scene}/plans`, { space: space.id, topic, minutes, workflow })).body

const act = async (plan: Plan, action: string, extra: Record<string, unknown> = {}) =>
  (await call<PlanReply>(`${scene}/plans/act`, { plan: plan.id, action, ...extra })).body

const read = async (plan: Plan) =>
  (await call<PlanReply & { turns: readonly Turn[] }>(`${scene}/plan?id=${plan.id}`)).body

const blocksOf = (plan: Plan): readonly string[] => plan.steps.map((step) => step.block)
const activeOf = (plan: Plan) => plan.steps.find((step) => step.status === 'active')

/** Runs a plan to the end, answering each thing as it comes. */
async function runToEnd(start_: Plan, answerWith: (question: PublicQuestion) => string) {
  let reply = await act(start_, 'begin')
  for (let guard = 0; reply.plan.status !== 'done' && guard < 60; guard += 1) {
    if (reply.question !== undefined) {
      reply = await act(reply.plan, 'answer', { text: answerWith(reply.question) })
    } else {
      reply = await act(reply.plan, 'next')
    }
  }
  return reply
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-plans-'))
  graph = join(directory, 'graph.db')
})

afterEach(async () => {
  if (running) await service.close()
  running = false
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('proposing a plan', () => {
  it('fits the focuses to the time, and the minutes add up to it', async () => {
    await start()
    const space = await spaceWithNotes()
    const speedrun = (await propose(space, 'speedrun', 60)).plan
    expect(speedrun.origin).toBe('outline')
    expect(speedrun.steps.reduce((sum, step) => sum + step.minutes, 0)).toBe(60)
    expect(blocksOf(speedrun)).toEqual([
      'overview',
      'explain',
      'check',
      'explain',
      'check',
      'explain',
      'check',
      'summary',
    ])
    const short = (await propose(space, 'speedrun', 15)).plan
    expect(short.steps.filter((step) => step.block === 'explain')).toHaveLength(1)
    expect(short.steps.reduce((sum, step) => sum + step.minutes, 0)).toBe(15)
  })

  it('uses the model for focuses, and drops any the material says nothing about', async () => {
    await start(new ScriptedModel())
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 60)
    expect(plan.origin).toBe('model')
    const focuses = new Set(plan.steps.map((step) => step.focus))
    expect(focuses.has('位置编码')).toBe(true)
    expect(focuses.has('月球的引力')).toBe(false)
  })

  it('still makes a plan when the model fails, and says so', async () => {
    const model = new ScriptedModel()
    model.failing = true
    await start(model)
    const space = await spaceWithNotes()
    const { plan, notice } = await propose(space, 'deep', 60)
    expect(plan.origin).toBe('outline')
    expect(notice).toContain('材料目录')
  })

  it('refuses a space with no material, a workflow that does not exist, and a silly time', async () => {
    await start()
    const { space } = (await call<{ space: Space }>(`${scene}/spaces`, { name: '空' })).body
    const body = { space: space.id, topic: 'x', minutes: 60, workflow: 'speedrun' }
    expect((await call(`${scene}/plans`, body)).body.code).toBe('no_material')
    const full = await spaceWithNotes()
    const again = { ...body, space: full.id }
    expect((await call(`${scene}/plans`, { ...again, workflow: 'nope' })).body.code).toBe(
      'unknown_workflow',
    )
    expect((await call(`${scene}/plans`, { ...again, minutes: 0 })).body.code).toBe(
      'invalid_request',
    )
  })

  it('skips in a speedrun what the person has confirmed, and lets them put it back', async () => {
    await start()
    const space = await spaceWithNotes()
    await call(`${scene}/ask`, { space: space.id, question: '位置编码有什么用' })
    const sessions = (
      await call<{ sessions: readonly { id: string }[] }>(`${scene}/sessions?space=${space.id}`)
    ).body.sessions
    const thread = sessions[0]?.id ?? ''
    const session = await call<{ turns: readonly (Turn & { id: string })[] }>(
      `${scene}/session?thread=${thread}`,
    )
    const reply = session.body.turns.at(-1)?.id
    const made = await call<{ suggestions: readonly { id: string }[] }>(`${scene}/candidates`, {
      space: space.id,
      thread,
      reply,
    })
    await call('/suggestions/decide', {
      id: made.body.suggestions[0]?.id,
      action: 'modify',
      proposal: { kind: 'node', nodeType: 'claim', label: '位置编码' },
    })

    const { plan } = await propose(space, 'speedrun', 60)
    const skipped = plan.steps.filter((step) => step.status === 'skipped')
    expect(skipped.map((step) => step.focus)).toEqual(['位置编码', '位置编码'])
    expect(skipped[0]?.note).toContain('确认')
    // The deep mode does not assume: going over it again is the point.
    expect((await propose(space, 'deep', 60)).plan.steps.every((s) => s.status === 'pending')).toBe(
      true,
    )

    const restored = await call<PlanReply>(`${scene}/plans/update`, {
      plan: plan.id,
      steps: plan.steps.map((step) => ({ ...step, restore: true })),
    })
    expect(restored.body.plan.steps.every((step) => step.status === 'pending')).toBe(true)
  })
})

describe('editing a plan', () => {
  it('changes what lies ahead, keeps the earlier version, and refuses to rewrite what happened', async () => {
    await start()
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 60)
    const started = (await act(plan, 'begin')).plan
    const [first, second, ...rest] = started.steps
    if (first === undefined || second === undefined) throw new Error('expected steps')

    const edited = (
      await call<PlanReply>(`${scene}/plans/update`, {
        plan: plan.id,
        steps: [first, { ...second, focus: '多头注意力', minutes: 20 }, ...rest.slice(1)],
      })
    ).body.plan
    expect(edited.version).toBe(2)
    expect(edited.steps[1]).toMatchObject({ focus: '多头注意力', minutes: 20 })
    expect(edited.steps).toHaveLength(started.steps.length - 1)

    const ahead = edited.steps.slice(1)
    const rewrite = await call(`${scene}/plans/update`, {
      plan: plan.id,
      steps: [{ ...first, focus: '别的' }, ...ahead],
    })
    expect(rewrite.body.code).toBe('step_locked')
    const dropped = await call(`${scene}/plans/update`, { plan: plan.id, steps: ahead })
    expect(dropped.body.code).toBe('step_locked')
    const before = await call(`${scene}/plans/update`, {
      plan: plan.id,
      steps: [{ block: 'explain', focus: '新的', minutes: 5 }, first, ...ahead],
    })
    expect(before.body.code).toBe('step_locked')
  })

  it('refuses a block that does not exist and a step that is not a step', async () => {
    await start()
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 60)
    const unknown = await call(`${scene}/plans/update`, {
      plan: plan.id,
      steps: [{ block: 'hypnosis', focus: 'x', minutes: 5 }],
    })
    expect(unknown.body.code).toBe('unknown_block')
    const junk = await call(`${scene}/plans/update`, { plan: plan.id, steps: [null, 3] })
    expect(junk.status).toBe(422)
    expect((await call(`${scene}/plans/update`, { plan: plan.id, steps: [] })).status).toBe(422)
  })

  it('pauses, refuses to move while paused, and resumes where it stopped', async () => {
    await start()
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 60)
    const started = (await act(plan, 'begin')).plan
    const paused = await call<PlanReply>(`${scene}/plans/update`, {
      plan: plan.id,
      status: 'paused',
    })
    expect(paused.body.plan.status).toBe('paused')
    expect(
      (await call(`${scene}/plans/act`, { plan: plan.id, action: 'next' })).body,
    ).toMatchObject({ code: 'plan_paused' })
    const resumed = await call<PlanReply>(`${scene}/plans/update`, {
      plan: plan.id,
      status: 'active',
    })
    expect(activeOf(resumed.body.plan)?.id).toBe(activeOf(started)?.id)
  })
})

describe('a speedrun', () => {
  it('runs from overview to a summary with what was left unresolved', async () => {
    await start()
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 60)
    const done = await runToEnd(plan, () => '不知道')
    expect(done.plan.status).toBe('done')
    expect(done.plan.steps.every((step) => step.status === 'done')).toBe(true)

    const { turns } = await read(plan)
    const summary = turns.at(-1)?.text ?? ''
    expect(summary).toContain('学过')
    expect(summary).toContain('还没解决')
    expect(summary).toContain('不代表你掌握了多少')
    // The explanations cite the material.
    const cited = turns.filter((turn) => turn.answer?.status === 'answered')
    expect(cited.length).toBeGreaterThan(3)
    // A plan that is over stays over.
    expect((await call(`${scene}/plans/act`, { plan: plan.id, action: 'next' })).body.code).toBe(
      'plan_done',
    )
  })

  it('takes a blank as answered right when the word is right', async () => {
    await start()
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 15, '位置编码')
    let reply = await act(plan, 'begin')
    reply = await act(reply.plan, 'next')
    reply = await act(reply.plan, 'next')
    expect(reply.question?.kind).toBe('cloze')
    // Reads the answer as only a test can: from the stored attempt, via the sentence's source.
    const blank = /填空：(.*)/.exec(reply.question?.prompt ?? '')?.[1] ?? ''
    const [before = '', after = ''] = blank.split('____')
    const word = NOTES.split(before)[1]?.split(after)[0] ?? ''
    expect(word.length).toBeGreaterThan(1)
    const answered = await act(reply.plan, 'answer', { text: ` ${word} ` })
    expect(answered.question).toBeUndefined()
    const { turns } = await read(plan)
    expect(turns.map((turn) => turn.text)).toContain('答对了。')
    expect(turns.at(-1)?.answer?.citations[0]?.title).toBe('笔记.md')
    // A mechanical check, so it says no model judged it.
    expect(turns.at(-1)?.by).toBe('workbench')
  })
})

describe('a deep plan', () => {
  it('opens without spending a call, follows up, and converges instead of asking for ever', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'deep', 30, '位置编码')
    let reply = await act(plan, 'begin')
    reply = await act(reply.plan, 'next')
    expect(activeOf(reply.plan)?.block).toBe('retell')

    const calls = model.calls.length
    const opening = (await read(plan)).turns.at(-1)
    expect(opening?.text).toContain('用你自己的话')
    expect(model.calls.length).toBe(calls)

    reply = await act(reply.plan, 'reply', { text: '它告诉模型词的顺序' })
    expect(activeOf(reply.plan)?.rounds).toBe(1)
    const followUp = (await read(plan)).turns.at(-1)
    // The question it ends on is neither the material's claim nor an inference.
    expect(followUp?.answer?.segments.at(-1)?.basis).toBe('question')
    expect(followUp?.text).not.toContain('[推断]')
    expect(model.calls.at(-1)?.[0]?.content).toContain('提一个追问')
    expect(model.calls.at(-1)?.[0]?.content).not.toContain('不要再提问')

    reply = await act(reply.plan, 'reply', { text: '还有呢' })
    reply = await act(reply.plan, 'reply', { text: '我想想' })
    expect(activeOf(reply.plan)?.rounds).toBe(3)
    expect(model.calls.at(-1)?.[0]?.content).toContain('不要再提问')
  })

  it('explains directly whenever the person asks, and lets them move on at any time', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'deep', 30, '位置编码')
    let reply = await act(plan, 'begin')
    reply = await act(reply.plan, 'next')
    reply = await act(reply.plan, 'direct')
    expect(activeOf(reply.plan)?.note).toContain('直接讲解')
    expect(model.calls.at(-1)?.[0]?.content).toContain('直接讲清楚')
    const before = activeOf(reply.plan)?.id
    reply = await act(reply.plan, 'next')
    expect(reply.plan.steps.find((step) => step.id === before)?.status).toBe('done')
  })

  it('reads a free answer as a model estimate, which the mechanical check never mixes with', async () => {
    const model = new ScriptedModel()
    model.question = '{"kind":"short","prompt":"为什么需要位置编码？","excerpt":1}'
    await start(model)
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'deep', 30, '位置编码')
    let reply = await act(plan, 'begin')
    for (let guard = 0; reply.question === undefined && guard < 5; guard += 1) {
      reply = await act(reply.plan, 'next')
    }
    expect(reply.question).toEqual({ kind: 'short', prompt: '为什么需要位置编码？' })
    model.reply = '【部分对】你说到了顺序，但材料还说注意力看不出先后[1]。'
    reply = await act(reply.plan, 'answer', { text: '因为要知道顺序' })
    const { turns } = await read(plan)
    expect(turns.map((turn) => turn.text)).toContain('模型估计：答对了一部分。')
    expect(turns.at(-1)?.text).not.toContain('【部分对】')

    const status = await call<{
      checked: { total: number }
      estimated: { partial: number }
      confirmed: number
      review: readonly { focus: string; due: boolean }[]
    }>(`${scene}/status?space=${space.id}`)
    expect(status.body.checked.total).toBe(0)
    expect(status.body.estimated.partial).toBe(1)
    expect(status.body.confirmed).toBe(0)
    expect(status.body.review[0]?.focus).toBe('位置编码')
  })
})

describe('what a plan keeps safe', () => {
  it('never lets the page see the answer before the person has answered', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 15, '位置编码')
    let reply = await act(plan, 'begin')
    reply = await act(reply.plan, 'next')
    reply = await act(reply.plan, 'next')
    expect(reply.question?.options).toEqual(['顺序', '颜色'])
    const seen = [
      reply,
      await read(plan),
      (await call(`${scene}/plans?space=${space.id}`)).body,
      (await call(`${scene}/status?space=${space.id}`)).body,
    ]
    for (const body of seen) {
      const text = JSON.stringify(body)
      expect(text).not.toContain('"answer":0')
      expect(text).not.toContain('"citation"')
    }
    // The prompt is in the thread only after answering, so a later model call cannot leak it either.
    expect((await read(plan)).turns.map((turn) => turn.text)).not.toContain(reply.question?.prompt)

    const answered = await act(reply.plan, 'answer', { text: '1' })
    const { turns } = await read(plan)
    expect(turns.map((turn) => turn.text)).toContain('没答对。正确答案是“顺序”。')
    expect(
      (await call(`${scene}/plans/act`, { plan: plan.id, action: 'answer', text: '0' })).body,
    ).toMatchObject({ code: 'already_answered' })
    expect(answered.plan.status).toBe('active')
  })

  it('survives a model failure at every kind of step, and a retry repeats nothing', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'deep', 30, '位置编码')

    // A step that fails to open.
    model.failing = true
    let reply = await act(plan, 'begin')
    expect(reply.failure).toMatchObject({ code: 'timeout', retryable: true })
    expect(activeOf(reply.plan)?.entered).toBe(false)
    // Moving on is trying again: the step never happened.
    const failedStep = activeOf(reply.plan)?.id
    reply = await act(reply.plan, 'next')
    expect(reply.failure?.code).toBe('timeout')
    expect(activeOf(reply.plan)?.id).toBe(failedStep)
    model.failing = false
    reply = await act(reply.plan, 'begin')
    expect(reply.failure).toBeUndefined()
    expect(activeOf(reply.plan)?.entered).toBe(true)
    expect(activeOf(reply.plan)?.id).toBe(failedStep)

    // A reply that fails.
    reply = await act(reply.plan, 'next')
    model.failing = true
    reply = await act(reply.plan, 'reply', { text: '它告诉模型顺序' })
    expect(reply.failure?.code).toBe('timeout')
    expect(activeOf(reply.plan)?.rounds).toBe(0)
    model.failing = false
    reply = await act(reply.plan, 'reply', { text: '它告诉模型顺序', retry: true })
    expect(activeOf(reply.plan)?.rounds).toBe(1)
    const said = (await read(plan)).turns.filter((turn) => turn.text === '它告诉模型顺序')
    expect(said).toHaveLength(1)

    // A free answer that fails.
    reply = await act(reply.plan, 'next')
    model.question = '{"kind":"short","prompt":"为什么？","excerpt":1}'
    model.failing = true
    reply = await act(reply.plan, 'next')
    expect(reply.failure?.code).toBe('timeout')
    model.failing = false
    reply = await act(reply.plan, 'next')
    expect(reply.question?.kind).toBe('short')
    model.failing = true
    reply = await act(reply.plan, 'answer', { text: '因为顺序' })
    expect(reply.failure?.code).toBe('timeout')
    expect(reply.question?.kind).toBe('short')
    model.failing = false
    reply = await act(reply.plan, 'answer', { text: '因为顺序' })
    expect(reply.question).toBeUndefined()
    expect((await read(plan)).turns.filter((turn) => turn.text === '因为顺序')).toHaveLength(1)
  })

  it('carries on from the same step after the service restarts', async () => {
    await start()
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 15, '位置编码')
    let reply = await act(plan, 'begin')
    reply = await act(reply.plan, 'next')
    reply = await act(reply.plan, 'next')
    const prompt = reply.question?.prompt
    expect(prompt).toBeDefined()
    await service.close()

    await start()
    const after = await read(plan)
    expect(after.plan.steps).toEqual(reply.plan.steps)
    expect(after.question?.prompt).toBe(prompt)
    expect(after.turns.length).toBeGreaterThan(0)
    const done = await runToEnd(after.plan, () => '不知道')
    expect(done.plan.status).toBe('done')
  })

  it('writes nothing to understanding, however well the person did', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 30)
    await runToEnd(plan, () => '0')
    const understanding = await call<{ nodes: unknown[]; pending: unknown[] }>(
      `${scene}/understanding?space=${space.id}`,
    )
    expect(understanding.body.nodes).toEqual([])
    expect(understanding.body.pending).toEqual([])
    const status = await call<{
      checked: { correct: number; total: number }
      confirmed: number
    }>(`${scene}/status?space=${space.id}`)
    expect(status.body.checked.correct).toBeGreaterThan(0)
    expect(status.body.confirmed).toBe(0)
  })

  it('lets what a plan said be proposed as understanding, through the same review', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { plan } = await propose(space, 'speedrun', 15, '位置编码')
    await act(plan, 'begin')
    const turns = await call<{ turns: readonly (Turn & { id: string })[] }>(
      `${scene}/session?thread=${plan.thread}`,
    )
    const reply = turns.body.turns.find((turn) => turn.answer?.status === 'answered')
    const made = await call<{ suggestions: unknown[] }>(`${scene}/candidates`, {
      space: space.id,
      thread: plan.thread,
      reply: reply?.id,
    })
    expect(made.body.suggestions.length).toBeGreaterThan(0)
  })
})

describe('the learning library', () => {
  it('runs a new way of learning that is only data', async () => {
    const library: Library = {
      blocks: [
        ...BUILT_IN_LIBRARY.blocks,
        {
          id: 'teach-back',
          title: '讲给别人听',
          interaction: 'dialog',
          weight: 1,
          maxRounds: 1,
          opening: '把{focus}讲给一个完全不懂的人听。',
          instruction: '指出讲解中和材料不符的地方。',
        },
      ],
      workflows: [
        ...BUILT_IN_LIBRARY.workflows,
        {
          id: 'feynman',
          title: '费曼',
          description: '讲给别人听。',
          opening: [],
          perFocus: ['teach-back'],
          closing: ['summary'],
          minutesPerFocus: 10,
          skipsUnderstood: false,
        },
      ],
    }
    await start(new SimulatedModel(), { library })
    const space = await spaceWithNotes()
    const listed = await call<{ workflows: readonly { id: string }[] }>(`${scene}/workflows`)
    expect(listed.body.workflows.map((workflow) => workflow.id)).toContain('feynman')
    const { plan } = await propose(space, 'feynman', 10, '位置编码')
    expect(blocksOf(plan)).toEqual(['teach-back', 'summary'])
    const opened = await act(plan, 'begin')
    expect((await read(plan)).turns.at(-1)?.text).toContain('讲给一个完全不懂的人听')
    expect((await act(opened.plan, 'next')).plan.status).toBe('done')
  })

  it('finds a mistake before it can be reached in a plan', () => {
    expect(libraryProblems(BUILT_IN_LIBRARY)).toEqual([])
    const broken: Library = {
      blocks: [
        { id: 'endless', title: 'x', interaction: 'dialog', weight: 1, opening: 'x' },
        { id: 'odd', title: 'x', interaction: 'ritual' as 'tell', weight: 0 },
      ],
      workflows: [
        {
          id: 'w',
          title: 'x',
          description: 'x',
          opening: ['ghost'],
          perFocus: [],
          closing: [],
          minutesPerFocus: 0,
          skipsUnderstood: false,
        },
      ],
    }
    const problems = libraryProblems(broken).join('\n')
    expect(problems).toContain('"endless" needs a positive maxRounds')
    expect(problems).toContain('unknown interaction "ritual"')
    expect(problems).toContain('unknown block "ghost"')
    expect(problems).toContain('positive minutesPerFocus')
    expect(() => workbenchProfile({ model: new SimulatedModel(), library: broken })).toThrow(
      /Invalid learning library/,
    )
  })
})

describe('questions and how they are judged', () => {
  const hit = (text: string): SearchHit =>
    ({
      material: { id: 'm', title: '笔记', version: 1 },
      chunk: { index: 0, start: 0, end: text.length, text, line: 1 },
      score: 1,
      coverage: 1,
    }) as SearchHit

  it('blanks a whole word that the focus does not give away', () => {
    const question = clozeFrom('位置编码', [hit('位置编码把序列的顺序告诉模型，顺序很重要。')])
    expect(question?.kind).toBe('cloze')
    expect(question?.prompt).toContain('____')
    expect(question?.prompt).toContain('位置编码')
    expect(question?.prompt).not.toContain(String(question?.answer))
    expect(checkAnswer(question as Question, String(question?.answer))).toBe(true)
    expect(checkAnswer(question as Question, '别的')).toBe(false)
    expect(clozeFrom('位置', [hit('# 标题')])).toBeUndefined()
  })

  it('leaves a free answer without a mechanical verdict', () => {
    const question = { kind: 'short', prompt: 'p', citation: {} } as Question
    expect(checkAnswer(question, '随便')).toBeUndefined()
  })

  it('takes the estimate off the front, and invents none when there is none', () => {
    const model = new SimulatedModel()
    const marked = estimateFrom(checkReply('【不对】说反了。', [], model))
    expect(marked.estimate).toBe('wrong')
    expect(marked.answer.segments[0]?.text).toBe('说反了。')
    expect(estimateFrom(checkReply('说反了。', [], model)).estimate).toBeUndefined()
  })

  it('suggests going back by the latest answer on each focus', () => {
    const DAY = 86_400_000
    const attempt = (focus: string, at: number, result: Partial<Attempt>): Attempt =>
      ({ focus, answeredAt: at, ...result }) as Attempt
    const suggestions = reviewSuggestions(
      [
        attempt('甲', 0, { correct: false }),
        attempt('甲', DAY, { correct: true }),
        attempt('乙', 0, { estimate: 'wrong' }),
        attempt('丙', 0, { estimate: 'partial' }),
        { focus: '丁', question: {} } as Attempt,
      ],
      2 * DAY,
    )
    expect(suggestions.map(({ focus, due }) => [focus, due])).toEqual([
      ['乙', true],
      ['丙', false],
      ['甲', false],
    ])
  })
})
