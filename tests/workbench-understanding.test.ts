import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type EpistemeService } from '@episteme/service'
import {
  ModelFailure,
  SimulatedModel,
  workbenchProfile,
  type Answer,
  type Challenge,
  type HeldNode,
  type ModelClient,
  type ModelMessage,
  type Space,
  type TrailEntry,
} from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const NOTES = `# Transformer 笔记

## 位置编码

位置编码把序列的顺序告诉模型。没有它，注意力机制看不出词的先后。

## 自注意力

自注意力让每个词根据其他词调整自己的表示。它计算查询和键的相似度，再对值加权。
`

interface Reply<T> {
  readonly status: number
  readonly body: T & { readonly code?: string; readonly error?: string }
}

interface Pending {
  readonly id: string
  readonly basis?: string
  readonly speaker?: string
  readonly similar?: string
  readonly proposal: {
    readonly kind: string
    readonly label?: string
    readonly from?: string
    readonly to?: string
    readonly relation?: string
  }
  readonly origin?: { readonly excerpt?: string }
  readonly link?: { readonly fromLabel: string; readonly toLabel: string; readonly ready: boolean }
}

interface Held {
  readonly nodes: readonly HeldNode[]
  readonly pending: readonly Pending[]
  readonly challenges: readonly Challenge[]
}

interface Submitted {
  readonly suggestions: readonly { readonly id: string }[]
  readonly refused: readonly { readonly code: string }[]
  readonly message?: string
  readonly failure?: { readonly code: string; readonly retryable: boolean }
}

/** A model that answers by what it is asked for, and fails on demand. */
class ScriptedModel implements ModelClient {
  readonly name = 'scripted'
  readonly simulated = false
  readonly calls: (readonly ModelMessage[])[] = []
  failing = false
  thread = '{"items":[]}'
  challenge =
    '{"challenge":"没有位置编码时，模型真的完全不知道顺序吗？","quote":"没有它，注意力机制看不出词的先后。"}'
  reply = '位置编码把序列的顺序告诉模型[1]。'

  complete(messages: readonly ModelMessage[]) {
    this.calls.push(messages)
    if (this.failing) return Promise.reject(new ModelFailure('timeout', '模型超时了。'))
    const system = messages[0]?.content ?? ''
    if (system.includes('理解单元')) return Promise.resolve({ text: this.thread })
    if (system.includes('提出一个质疑')) return Promise.resolve({ text: this.challenge })
    return Promise.resolve({ text: this.reply })
  }
}

let directory: string
let graph: string
let service: EpistemeService
let running = false

const scene = '/scene/workbench'

const start = async (model: ModelClient = new SimulatedModel()): Promise<void> => {
  service = await startService({ graph, port: 0, profile: workbenchProfile({ model }) })
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

async function spaceWithNotes(name = '机器学习'): Promise<Space> {
  const { space } = (await call<{ space: Space }>(`${scene}/spaces`, { name })).body
  await call(`${scene}/materials`, {
    space: space.id,
    fileName: '笔记.md',
    contentBase64: Buffer.from(NOTES).toString('base64'),
  })
  return space
}

const held = async (space: Space): Promise<Held> =>
  (await call<Held>(`${scene}/understanding?space=${space.id}`)).body

const accept = (id: string) => call('/suggestions/decide', { id, action: 'accept' })

const ask = async (space: Space, question: string, thread?: string) =>
  (
    await call<{ thread: string; turn: string; reply?: string; answer?: Answer }>(`${scene}/ask`, {
      space: space.id,
      question,
      ...(thread === undefined ? {} : { thread }),
    })
  ).body

/** Says something in a conversation, and makes it a confirmed understanding. */
async function hold(
  space: Space,
  words: string,
): Promise<{ node: HeldNode; thread: string; turn: string }> {
  const asked = await ask(space, words)
  const submitted = await call<Submitted>(`${scene}/candidates/turn`, {
    space: space.id,
    thread: asked.thread,
    turn: asked.turn,
  })
  const [suggestion] = submitted.body.suggestions
  if (suggestion === undefined) throw new Error(JSON.stringify(submitted.body))
  await accept(suggestion.id)
  const node = (await held(space)).nodes.find((candidate) => candidate.label === words)
  if (node === undefined) throw new Error(`not held: ${words}`)
  return { node, thread: asked.thread, turn: asked.turn }
}

/** Saves a revision as the page does: the new wording first, then the edge from the old. */
async function revise(space: Space, node: HeldNode, label: string, reason?: string) {
  const reply = await call<Submitted>(`${scene}/understanding/revise`, {
    space: space.id,
    node: node.nodeId,
    label,
    ...(reason === undefined ? {} : { reason }),
  })
  expect(reply.status).toBe(200)
  for (const suggestion of reply.body.suggestions) {
    const decided = await accept(suggestion.id)
    expect(decided.status).toBe(200)
  }
  const found = (await held(space)).nodes.find((candidate) => candidate.label === label)
  if (found === undefined) throw new Error(`not revised: ${label}`)
  return found
}

const nodeNamed = async (space: Space, id: string) => {
  const node = (await held(space)).nodes.find((candidate) => candidate.nodeId === id)
  if (node === undefined) throw new Error(`no node ${id}`)
  return node
}

const trailOf = async (space: Space, id: string) =>
  (
    await call<{ trail: readonly TrailEntry[] }>(
      `${scene}/understanding/trail?space=${space.id}&node=${id}`,
    )
  ).body.trail

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-understanding-'))
  graph = join(directory, 'graph.db')
})

afterEach(async () => {
  if (running) await service.close()
  running = false
  await rm(directory, { recursive: true, force: true })
})

describe('candidates', () => {
  it('offers the person their own words as stated, and nothing is theirs until accepted', async () => {
    await start()
    const space = await spaceWithNotes()
    const asked = await ask(space, '位置编码就是告诉模型词的顺序')
    const submitted = await call<Submitted>(`${scene}/candidates/turn`, {
      space: space.id,
      thread: asked.thread,
      turn: asked.turn,
    })
    expect(submitted.body.suggestions).toHaveLength(1)

    const before = await held(space)
    expect(before.nodes).toEqual([])
    expect(before.pending[0]?.basis).toBe('stated')
    expect(before.pending[0]?.speaker).toBe('learner')

    await accept(before.pending[0]?.id ?? '')
    const [node] = (await held(space)).nodes
    expect(node?.label).toBe('位置编码就是告诉模型词的顺序')
    expect(node?.origin).toMatchObject({
      speaker: 'learner',
      basis: 'stated',
      thread: asked.thread,
      turn: asked.turn,
    })
    // Being said and accepted is not mastery: no level of understanding appears by itself.
    expect(node?.understanding).toEqual([])
  })

  it('refuses a model turn offered as the person words, and says when it is known already', async () => {
    await start()
    const space = await spaceWithNotes()
    const asked = await ask(space, '位置编码就是告诉模型词的顺序')
    const asModel = await call(`${scene}/candidates/turn`, {
      space: space.id,
      thread: asked.thread,
      turn: asked.reply,
    })
    expect(asModel.status).toBe(422)
    expect(asModel.body.code).toBe('unknown_turn')

    const offer = () =>
      call<Submitted>(`${scene}/candidates/turn`, {
        space: space.id,
        thread: asked.thread,
        turn: asked.turn,
      })
    const first = await offer()
    await accept(first.body.suggestions[0]?.id ?? '')
    const again = await ask(space, '位置编码就是告诉模型词的顺序', asked.thread)
    const repeated = await call<Submitted>(`${scene}/candidates/turn`, {
      space: space.id,
      thread: asked.thread,
      turn: again.turn,
    })
    expect(repeated.body.suggestions).toEqual([])
    expect(repeated.body.message).toBe('你已经确认过这条了。')
  })

  it('keeps an answer sentence as the model words, with where it came from', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const asked = await ask(space, '位置编码的作用是什么')
    await call(`${scene}/candidates`, { space: space.id, thread: asked.thread, reply: asked.reply })
    const { pending } = await held(space)
    expect(pending[0]?.basis).toBe('inferred')
    expect(pending[0]?.speaker).toBe('model')
    await accept(pending[0]?.id ?? '')
    const [node] = (await held(space)).nodes
    expect(node?.origin).toMatchObject({ speaker: 'model', basis: 'inferred', turn: asked.reply })
  })

  it('decides whose words a thread candidate is by where the quote is, not what the model says', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const asked = await ask(space, '位置编码告诉模型什么？我觉得它是可有可无的')
    model.thread = JSON.stringify({
      items: [
        { ref: 'a', role: 'claim', label: '位置编码可有可无', quote: '我觉得它是可有可无的' },
        { ref: 'b', role: 'claim', label: '位置编码告诉模型顺序', quote: '序列的顺序告诉模型' },
        { ref: 'c', role: 'claim', label: '模型编造的句子', quote: '对话里根本没有这句话' },
      ],
      relations: [{ from: 'b', to: 'a', relation: 'contradicts', quote: '序列的顺序告诉模型' }],
    })
    const submitted = await call<Submitted>(`${scene}/candidates/thread`, {
      space: space.id,
      thread: asked.thread,
    })
    expect(submitted.body.suggestions).toHaveLength(3)

    const { pending } = await held(space)
    const byLabel = new Map(pending.map((item) => [item.proposal.label, item]))
    expect(byLabel.get('位置编码可有可无')?.basis).toBe('stated')
    expect(byLabel.get('位置编码告诉模型顺序')?.basis).toBe('inferred')
    expect(byLabel.has('模型编造的句子')).toBe(false)
    // No state is proposed from a conversation: having mentioned something says nothing about having mastered it.
    expect(pending.some((item) => item.proposal.kind === 'state')).toBe(false)

    const link = pending.find((item) => item.proposal.kind === 'link')
    expect(link?.link).toEqual({
      fromLabel: '位置编码告诉模型顺序',
      toLabel: '位置编码可有可无',
      ready: false,
    })
    await accept(byLabel.get('位置编码可有可无')?.id ?? '')
    await accept(byLabel.get('位置编码告诉模型顺序')?.id ?? '')
    const after = (await held(space)).pending.find((item) => item.proposal.kind === 'link')
    expect(after?.link?.ready).toBe(true)
    expect((await accept(after?.id ?? '')).status).toBe(200)
    const nodes = (await held(space)).nodes
    expect(nodes.flatMap((node) => node.relations).map((relation) => relation.type)).toContain(
      'contradicts',
    )
  })

  it('does not offer a bare question, or the same thought twice', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const asked = await ask(space, '我觉得位置编码可有可无，它只是一个辅助手段')
    model.thread = JSON.stringify({
      items: [
        { ref: 'q', role: 'claim', label: '位置编码是干什么的？', quote: '位置编码可有可无' },
        { ref: 'r', role: 'question', label: '它为什么存在', quote: '位置编码可有可无' },
        {
          ref: 'a',
          role: 'claim',
          label: '位置编码可有可无，它只是一个辅助手段',
          quote: '位置编码可有可无',
        },
        {
          ref: 'b',
          role: 'claim',
          label: '位置编码可有可无，只是一个辅助手段',
          quote: '位置编码可有可无',
        },
      ],
      relations: [{ from: 'q', to: 'a', relation: 'supports', quote: '位置编码可有可无' }],
    })
    await call(`${scene}/candidates/thread`, { space: space.id, thread: asked.thread })
    const { pending } = await held(space)
    expect(pending.map((item) => item.proposal.label)).toEqual([
      '位置编码可有可无，它只是一个辅助手段',
    ])

    // A model does not repeat it, but the person may: they are told, not stopped.
    const session = await call<{ turns: readonly { id: string; speaker: string }[] }>(
      `${scene}/session?thread=${asked.thread}`,
    )
    const turn = session.body.turns.find((candidate) => candidate.speaker === 'learner')
    const offered = await call<Submitted>(`${scene}/candidates/turn`, {
      space: space.id,
      thread: asked.thread,
      turn: turn?.id,
    })
    expect(offered.body.suggestions).toHaveLength(1)
    const both = (await held(space)).pending
    expect(both.map((item) => item.similar)).toEqual([
      '我觉得位置编码可有可无，它只是一个辅助手段',
      '位置编码可有可无，它只是一个辅助手段',
    ])
    await call('/suggestions/decide', { id: both[1]?.id, action: 'dismiss' })

    // Nor does a second reading of the conversation bring it back once it is confirmed.
    await accept(pending[0]?.id ?? '')
    const again = await call<Submitted>(`${scene}/candidates/thread`, {
      space: space.id,
      thread: asked.thread,
    })
    expect(again.body.suggestions).toEqual([])
    expect(again.body.message).toBe('这段对话里没有挑出新的内容。')
  })

  it('never takes opposite claims for the same one', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const asked = await ask(space, '有人说位置编码是必需的，也有人说位置编码不是必需的')
    model.thread = JSON.stringify({
      items: [
        { ref: 'a', role: 'claim', label: '位置编码是必需的', quote: '位置编码是必需的' },
        { ref: 'b', role: 'claim', label: '位置编码不是必需的', quote: '位置编码不是必需的' },
      ],
    })
    await call(`${scene}/candidates/thread`, { space: space.id, thread: asked.thread })
    const { pending } = await held(space)
    expect(pending.map((item) => item.proposal.label).sort()).toEqual([
      '位置编码不是必需的',
      '位置编码是必需的',
    ])
    expect(pending.every((item) => item.similar === undefined)).toBe(true)
  })

  it('reports a model failure as retryable, and a simulated model as not able to', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const asked = await ask(space, '我觉得位置编码是可有可无的')
    model.failing = true
    const failed = await call<Submitted>(`${scene}/candidates/thread`, {
      space: space.id,
      thread: asked.thread,
    })
    expect(failed.status).toBe(200)
    expect(failed.body.failure).toMatchObject({ code: 'timeout', retryable: true })
    expect((await held(space)).pending).toEqual([])
    await service.close()

    await start()
    const plain = await call<Submitted>(`${scene}/candidates/thread`, {
      space: space.id,
      thread: asked.thread,
    })
    expect(plain.body.suggestions).toEqual([])
    expect(plain.body.message).toContain('模拟模型')
  })
})

describe('revising', () => {
  it('keeps the old wording and leads from it to the new', async () => {
    await start()
    const space = await spaceWithNotes()
    const { node } = await hold(space, '位置编码是可有可无的')
    const revised = await revise(
      space,
      node,
      '没有位置编码，注意力机制看不出词的先后',
      '读了第二节',
    )

    const old = await nodeNamed(space, node.nodeId)
    expect(old.label).toBe('位置编码是可有可无的')
    expect(old.revisedTo).toBe(revised.nodeId)
    expect(revised.revisedTo).toBeUndefined()
    expect(revised.origin).toMatchObject({
      speaker: 'learner',
      basis: 'stated',
      reason: '读了第二节',
    })

    const oldTrail = await trailOf(space, node.nodeId)
    expect(oldTrail.map((entry) => entry.kind)).toEqual(['proposed', 'revised_to'])
    const newTrail = await trailOf(space, revised.nodeId)
    expect(newTrail.map((entry) => entry.kind)).toContain('revised_from')
  })

  it('refuses to revise what has already moved on, or to change nothing', async () => {
    await start()
    const space = await spaceWithNotes()
    const { node } = await hold(space, '位置编码是可有可无的')
    const same = await call(`${scene}/understanding/revise`, {
      space: space.id,
      node: node.nodeId,
      label: node.label,
    })
    expect(same.body.code).toBe('unchanged')
    await revise(space, node, '没有位置编码，注意力机制看不出词的先后')
    const twice = await call(`${scene}/understanding/revise`, {
      space: space.id,
      node: node.nodeId,
      label: '第三种说法，和前两种都不一样',
    })
    expect(twice.body.code).toBe('already_revised')
  })
})

describe('challenging', () => {
  it('keeps a challenge beside what it questions and changes nothing held', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { node } = await hold(space, '位置编码可有可无，注意力机制能看出先后')
    const reply = await call<{ challenge: Challenge }>(`${scene}/understanding/challenge`, {
      space: space.id,
      node: node.nodeId,
    })
    expect(reply.body.challenge).toMatchObject({
      status: 'open',
      by: 'model:scripted',
      quote: '没有它，注意力机制看不出词的先后。',
    })
    const after = await nodeNamed(space, node.nodeId)
    expect(after.label).toBe(node.label)
    expect(after.understanding).toEqual([])
    expect(after.openChallenges).toBe(1)

    const settled = await call<{ challenge: Challenge }>(
      `${scene}/understanding/challenge/settle`,
      {
        challenge: reply.body.challenge.id,
        status: 'dismissed',
        reason: '我想过了，不成立',
      },
    )
    expect(settled.body.challenge.status).toBe('dismissed')
    expect((await nodeNamed(space, node.nodeId)).openChallenges).toBe(0)
    const again = await call(`${scene}/understanding/challenge/settle`, {
      challenge: reply.body.challenge.id,
      status: 'conflict',
    })
    expect(again.body.code).toBe('already_settled')
  })

  it('does not present a quote the excerpts do not hold as the material', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { node } = await hold(space, '位置编码可有可无，注意力机制能看出先后')
    model.challenge = '{"challenge":"这个说法有反例吗？","quote":"材料里并没有这句话"}'
    const reply = await call<{ challenge: Challenge }>(`${scene}/understanding/challenge`, {
      space: space.id,
      node: node.nodeId,
    })
    expect(reply.body.challenge.text).toBe('这个说法有反例吗？')
    expect(reply.body.challenge.quote).toBeUndefined()
  })

  it('has nothing to challenge with when the material is silent, or with a simulated model', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { node } = await hold(space, '光合作用发生在叶绿体里')
    const silent = await call<{ challenge?: Challenge; message?: string }>(
      `${scene}/understanding/challenge`,
      { space: space.id, node: node.nodeId },
    )
    expect(silent.body.challenge).toBeUndefined()
    expect(silent.body.message).toContain('材料里没有讲到')
    await service.close()

    await start()
    const refused = await call(`${scene}/understanding/challenge`, {
      space: space.id,
      node: node.nodeId,
    })
    expect(refused.body.code).toBe('needs_model')
    const ownWords = await call<{ challenge: Challenge }>(`${scene}/understanding/challenge`, {
      space: space.id,
      node: node.nodeId,
      text: '那蓝藻呢？它没有叶绿体。',
    })
    expect(ownWords.body.challenge.by).toBe('self')
  })
})

describe('contradictions and withdrawal', () => {
  it('lets two contradicting understandings stand, with the conflict recorded by the person', async () => {
    await start()
    const space = await spaceWithNotes()
    const first = await hold(space, '位置编码是必须的')
    const second = await hold(space, '有些模型不用位置编码也能工作')
    const related = await call<Submitted>(`${scene}/understanding/relate`, {
      space: space.id,
      from: first.node.nodeId,
      to: second.node.nodeId,
      relation: 'contradicts',
    })
    await accept(related.body.suggestions[0]?.id ?? '')
    for (const node of [first.node, second.node]) {
      const recorded = await call('/record', {
        target: node.nodeId,
        dimensions: { conflict: 'open' },
        reason: '两条互相矛盾',
      })
      expect(recorded.status).toBe(200)
    }

    const nodes = (await held(space)).nodes
    expect(nodes).toHaveLength(2)
    expect(nodes.every((node) => node.conflict && node.revisedTo === undefined)).toBe(true)
    expect(nodes[0]?.relations.map((relation) => relation.type)).toContain('contradicts')

    await call('/record', {
      target: first.node.nodeId,
      dimensions: { conflict: 'resolved' },
      reason: '想通了',
    })
    expect((await nodeNamed(space, first.node.nodeId)).conflict).toBe(false)
    const trail = await trailOf(space, first.node.nodeId)
    expect(trail.flatMap((entry) => (entry.kind === 'state' ? [entry.level] : []))).toEqual([
      'open',
      'resolved',
    ])
  })

  it('withdraws through the history, and can take it back', async () => {
    await start()
    const space = await spaceWithNotes()
    const { node } = await hold(space, '位置编码是可有可无的')
    const withdrawn = await call('/record', {
      target: node.nodeId,
      dimensions: { stance: 'withdrawn' },
      reason: '我不再这么想',
    })
    expect(withdrawn.status).toBe(200)
    expect((await nodeNamed(space, node.nodeId)).withdrawn).toBe(true)
    await call('/record', { target: node.nodeId, dimensions: { stance: 'held' } })
    expect((await nodeNamed(space, node.nodeId)).withdrawn).toBe(false)
    const trail = await trailOf(space, node.nodeId)
    expect(trail.flatMap((entry) => (entry.kind === 'state' ? [entry.level] : []))).toEqual([
      'withdrawn',
      'held',
    ])
  })
})

describe('reusing', () => {
  it('brings confirmed understanding into a new conversation, and tells the model it is not material', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { node } = await hold(space, '位置编码告诉模型词的顺序')
    const asked = await ask(space, '位置编码有什么用')
    expect(asked.answer?.recalled).toEqual([
      { nodeId: node.nodeId, label: node.label, conflict: false },
    ])
    const prompt = model.calls.at(-1)?.at(-1)?.content ?? ''
    expect(prompt).toContain(`<prior>\n- ${node.label}`)
    expect(prompt).toContain('不是材料')
    // Being recalled does not make it a citation.
    expect(asked.answer?.citations.every((citation) => citation.quote !== node.label)).toBe(true)
  })

  it('offers what the person holds now, not what they gave up', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { node } = await hold(space, '位置编码可有可无')
    const revised = await revise(space, node, '位置编码必不可少，因为注意力机制看不出先后')
    const asked = await ask(space, '位置编码可有可无吗')
    expect(asked.answer?.recalled?.map((item) => item.nodeId)).toEqual([revised.nodeId])

    await call('/record', { target: revised.nodeId, dimensions: { stance: 'withdrawn' } })
    const later = await ask(space, '位置编码可有可无吗')
    expect(later.answer?.recalled).toBeUndefined()
  })

  it('says so when what comes back has an unresolved contradiction', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { node } = await hold(space, '位置编码告诉模型词的顺序')
    await call('/record', { target: node.nodeId, dimensions: { conflict: 'open' } })
    const asked = await ask(space, '位置编码有什么用')
    expect(asked.answer?.recalled?.[0]?.conflict).toBe(true)
    expect(model.calls.at(-1)?.at(-1)?.content).toContain('未解决的矛盾')
  })

  it('stays out of other spaces, and out of questions about something else', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    await hold(space, '位置编码告诉模型词的顺序')
    const unrelated = await ask(space, '自注意力怎么计算相似度')
    expect(unrelated.answer?.recalled).toBeUndefined()

    const other = await spaceWithNotes('另一门课')
    const elsewhere = await ask(other, '位置编码有什么用')
    expect(elsewhere.answer?.recalled).toBeUndefined()
  })

  it('still shows what was confirmed when the material says nothing on it', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { node } = await hold(space, '光合作用发生在叶绿体里')
    const before = model.calls.length
    const asked = await ask(space, '光合作用发生在哪里')
    expect(asked.answer?.status).toBe('insufficient_evidence')
    expect(asked.answer?.recalled?.[0]?.nodeId).toBe(node.nodeId)
    expect(model.calls.length).toBe(before)
  })

  it('leaves out of a new plan only what is still held', async () => {
    await start()
    const space = await spaceWithNotes()
    const { node } = await hold(space, '位置编码把序列的顺序告诉模型')
    const skipped = async () =>
      (
        await call<{ plan: { steps: readonly { focus: string; status: string }[] } }>(
          `${scene}/plans`,
          { space: space.id, topic: 'Transformer', minutes: 60, workflow: 'speedrun' },
        )
      ).body.plan.steps
        .filter((step) => step.status === 'skipped')
        .map((step) => step.focus)
    expect(await skipped()).toContain('位置编码')
    await call('/record', { target: node.nodeId, dimensions: { stance: 'withdrawn' } })
    expect(await skipped()).not.toContain('位置编码')
  })
})

describe('after a restart', () => {
  it('still has the whole trail: proposal, challenge, revision, and reuse', async () => {
    const model = new ScriptedModel()
    await start(model)
    const space = await spaceWithNotes()
    const { node, thread, turn } = await hold(space, '位置编码可有可无')
    const challenged = await call<{ challenge: Challenge }>(`${scene}/understanding/challenge`, {
      space: space.id,
      node: node.nodeId,
    })
    const revised = await revise(
      space,
      node,
      '位置编码必不可少，因为注意力机制看不出先后',
      '被问住了',
    )
    await call(`${scene}/understanding/challenge/settle`, {
      challenge: challenged.body.challenge.id,
      status: 'revised',
      revisedTo: revised.nodeId,
    })
    await service.close()

    await start(model)
    const trail = await trailOf(space, node.nodeId)
    expect(trail.map((entry) => entry.kind)).toEqual(['proposed', 'challenged', 'revised_to'])
    expect(trail[0]).toMatchObject({ kind: 'proposed', thread, turn, speaker: 'learner' })
    expect(trail[1]).toMatchObject({
      kind: 'challenged',
      challenge: { status: 'revised', revisedTo: revised.nodeId },
    })
    expect(trail[2]).toMatchObject({ kind: 'revised_to', node: revised.nodeId, reason: '被问住了' })
    const asked = await ask(space, '位置编码可有可无吗')
    expect(asked.answer?.recalled?.map((item) => item.nodeId)).toEqual([revised.nodeId])
    // The conversation it came from is still there to go back to.
    const session = await call<{ turns: readonly { id: string; text: string }[] }>(
      `${scene}/session?thread=${thread}`,
    )
    expect(session.body.turns.find((candidate) => candidate.id === turn)?.text).toBe(
      '位置编码可有可无',
    )
  })
})
