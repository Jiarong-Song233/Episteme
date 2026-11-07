import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import {
  workbenchProfile,
  type HeldNode,
  type ModelClient,
  type ModelMessage,
  type TrailEntry,
} from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Where an understanding came from, once conversations branch.
 *
 * Three things stay apart: the conversation the person had open, the conversation the words were said in, and the
 * words' own turn. A branch carries the turns of the lines above it with their ids, so a node drawn from carried
 * words goes back to them where they were said, while the branch it was made in stays named beside them.
 */

const NOTES = `# Transformer 笔记

## 位置编码

位置编码把序列的顺序告诉模型。没有它，注意力机制看不出词的先后。

## 自注意力

自注意力让每个词根据其他词调整自己的表示。它计算查询和键的相似度，再对值加权。
`

/** Answers with whatever it is set to say, citing the first passage, and picks from a thread what it is told to. */
class ScriptedModel implements ModelClient {
  readonly name = 'scripted'
  readonly simulated = false
  reply = '位置编码把序列的顺序告诉模型[1]。'
  thread = '{"items":[]}'

  complete(messages: readonly ModelMessage[]) {
    const system = messages[0]?.content ?? ''
    return Promise.resolve({ text: system.includes('理解单元') ? this.thread : this.reply })
  }
}

interface Submitted {
  readonly suggestions: readonly { readonly id: string; readonly proposal: { label?: string } }[]
  readonly refused: readonly { readonly code: string }[]
  readonly message?: string
}

interface Asked {
  readonly thread: string
  readonly turn: string
  readonly reply: string
}

let directory: string
let service: EpistemeService | undefined
let model: ScriptedModel
let token: string | undefined

const scene = '/scene/workbench'

async function call<T = Record<string, unknown>>(path: string, body?: unknown, as = token) {
  const response = await fetch(`${service!.apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(as === undefined ? {} : { authorization: `Bearer ${as}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as T & { code?: string } }
}

const start = async (): Promise<void> => {
  service = await startService({
    graph: join(directory, 'graph.db'),
    port: 0,
    profile: workbenchProfile({ model }),
  })
  token = service.humanToken
}

async function spaceWithNotes(): Promise<string> {
  const { space } = (await call<{ space: { id: string } }>(`${scene}/spaces`, { name: '论文' }))
    .body
  await call(`${scene}/materials`, {
    space: space.id,
    fileName: '笔记.md',
    contentBase64: Buffer.from(NOTES).toString('base64'),
  })
  return space.id
}

/** Asks, with the model set to answer in so many words. */
async function ask(space: string, question: string, answer: string, thread?: string) {
  model.reply = `${answer}[1]。`
  return (
    await call<Asked>(`${scene}/ask`, {
      space,
      question,
      ...(thread === undefined ? {} : { thread }),
    })
  ).body
}

const fork = async (space: string, thread: string, turn: string): Promise<string> =>
  (
    (await call<{ session: { id: string } }>(`${scene}/sessions/fork`, { space, thread, turn }))
      .body.session ?? { id: '' }
  ).id

const nodes = async (space: string): Promise<readonly HeldNode[]> =>
  (await call<{ nodes: readonly HeldNode[] }>(`${scene}/understanding?space=${space}`)).body.nodes

const accept = async (submitted: Submitted): Promise<void> => {
  expect(submitted.suggestions.length).toBeGreaterThan(0)
  for (const suggestion of submitted.suggestions) {
    expect(
      (await call('/suggestions/decide', { id: suggestion.id, action: 'accept' })).status,
    ).toBe(200)
  }
}

const offerTurn = async (space: string, thread: string, turn: string) =>
  (await call<Submitted>(`${scene}/candidates/turn`, { space, thread, turn })).body

const offerAnswer = async (space: string, thread: string, reply: string) =>
  (await call<Submitted>(`${scene}/candidates`, { space, thread, reply })).body

const nodeSaying = async (space: string, words: string): Promise<HeldNode> => {
  // An answer's sentence keeps its full stop.
  const found = (await nodes(space)).find((node) => node.label.replace(/。$/u, '') === words)
  if (found === undefined) throw new Error(`not held: ${words}`)
  return found
}

const proposed = async (space: string, node: string) => {
  const { trail } = (
    await call<{ trail: readonly TrailEntry[] }>(
      `${scene}/understanding/trail?space=${space}&node=${node}`,
    )
  ).body
  return trail.find((entry) => entry.kind === 'proposed')
}

const shown = async (thread: string) =>
  (
    await call<{ turns: readonly { id: string; inherited: boolean }[] }>(
      `${scene}/session?thread=${thread}`,
    )
  ).body.turns

/**
 * Three levels: a root conversation, a branch from its first answer, and a branch of that branch from its own answer.
 * The deepest one carries the root's turns and the middle one's, and has none of its own yet.
 */
async function threeLevels(space: string) {
  const root = await ask(space, '我认为位置编码告诉模型词的顺序', '位置编码把序列的顺序告诉模型')
  const middle = await fork(space, root.thread, root.reply)
  const second = await ask(
    space,
    '我觉得自注意力本身看不出先后',
    '注意力机制看不出词的先后',
    middle,
  )
  const deep = await fork(space, middle, second.reply)
  return { root, middle, second, deep }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-fork-origin-'))
  model = new ScriptedModel()
})

afterEach(async () => {
  await service?.close()
  service = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('where an understanding came from, across branches', () => {
  beforeEach(start)

  it('leaves a conversation that never branched as it was', async () => {
    const space = await spaceWithNotes()
    const root = await ask(space, '我认为位置编码告诉模型词的顺序', '位置编码把序列的顺序告诉模型')
    await accept(await offerTurn(space, root.thread, root.turn))
    await accept(await offerAnswer(space, root.thread, root.reply))

    const stated = await nodeSaying(space, '我认为位置编码告诉模型词的顺序')
    expect(stated.origin).toMatchObject({ basis: 'stated', thread: root.thread, turn: root.turn })
    expect(stated.origin?.madeIn).toBeUndefined()
    const inferred = await nodeSaying(space, '位置编码把序列的顺序告诉模型')
    expect(inferred.origin).toMatchObject({
      basis: 'inferred',
      thread: root.thread,
      turn: root.reply,
    })
    expect(inferred.origin?.madeIn).toBeUndefined()
    expect(await proposed(space, stated.nodeId)).toMatchObject({
      thread: root.thread,
      turn: root.turn,
    })
  })

  it('goes back to carried words where they were said, a parent or a grandparent, and names the branch it was made in', async () => {
    const space = await spaceWithNotes()
    const { root, middle, second, deep } = await threeLevels(space)

    // The person's own words, said in the grandparent, made theirs on the deepest branch.
    await accept(await offerTurn(space, deep, root.turn))
    const fromGrandparent = await nodeSaying(space, '我认为位置编码告诉模型词的顺序')
    expect(fromGrandparent.origin).toMatchObject({
      speaker: 'learner',
      basis: 'stated',
      thread: root.thread,
      turn: root.turn,
      madeIn: deep,
    })
    // Still the person's own typing: the words were found where they were said.
    expect(fromGrandparent.wordsBy).toBe('person')

    // Their words said in the parent.
    await accept(await offerTurn(space, deep, second.turn))
    expect((await nodeSaying(space, '我觉得自注意力本身看不出先后')).origin).toMatchObject({
      thread: middle,
      turn: second.turn,
      madeIn: deep,
    })

    // A model's sentence carried from the grandparent: its words go back there, the branch it was read on stays.
    await accept(await offerAnswer(space, deep, root.reply))
    expect((await nodeSaying(space, '位置编码把序列的顺序告诉模型')).origin).toMatchObject({
      speaker: 'model',
      basis: 'inferred',
      thread: root.thread,
      turn: root.reply,
      madeIn: deep,
    })

    // The trail sends "看原话" to the turn in its own conversation, which shows it as said there, not carried.
    const entry = await proposed(space, fromGrandparent.nodeId)
    expect(entry).toMatchObject({ thread: root.thread, turn: root.turn, madeIn: deep })
    expect((await shown(root.thread)).find((turn) => turn.id === root.turn)).toMatchObject({
      inherited: false,
    })
    // The branch it was made in still shows the same turn, carried over.
    expect((await shown(deep)).find((turn) => turn.id === root.turn)).toMatchObject({
      inherited: true,
    })
  })

  it('keeps what is new on a branch on the branch: the person’s words and a model’s reading', async () => {
    const space = await spaceWithNotes()
    const { deep } = await threeLevels(space)
    const own = await ask(
      space,
      '我觉得没有位置编码时词序信息会丢失',
      '自注意力让每个词根据其他词调整自己的表示',
      deep,
    )

    await accept(await offerTurn(space, deep, own.turn))
    const said = await nodeSaying(space, '我觉得没有位置编码时词序信息会丢失')
    expect(said.origin).toMatchObject({ basis: 'stated', thread: deep, turn: own.turn })
    expect(said.origin?.madeIn).toBeUndefined()

    await accept(await offerAnswer(space, deep, own.reply))
    const read = await nodeSaying(space, '自注意力让每个词根据其他词调整自己的表示')
    expect(read.origin).toMatchObject({ basis: 'inferred', thread: deep, turn: own.reply })
    expect(read.origin?.madeIn).toBeUndefined()
  })

  it('distils a whole branch with each quote traced to the conversation it was said in', async () => {
    const space = await spaceWithNotes()
    const { root, middle, second, deep } = await threeLevels(space)
    const own = await ask(
      space,
      '我觉得位置编码可以用相对位置代替',
      '自注意力计算查询和键的相似度',
      deep,
    )
    model.thread = JSON.stringify({
      items: [
        {
          ref: 'a',
          role: 'claim',
          label: '位置编码告诉模型词序',
          quote: '位置编码告诉模型词的顺序',
        },
        {
          ref: 'b',
          role: 'claim',
          label: '自注意力自己分不出先后',
          quote: '自注意力本身看不出先后',
        },
        {
          ref: 'c',
          role: 'claim',
          label: '注意力机制看不出词序',
          quote: '注意力机制看不出词的先后',
        },
        {
          ref: 'd',
          role: 'claim',
          label: '相对位置可以代替位置编码',
          quote: '位置编码可以用相对位置代替',
        },
      ],
      relations: [],
    })
    await accept(
      (await call<Submitted>(`${scene}/candidates/thread`, { space, thread: deep })).body,
    )

    const origins = new Map((await nodes(space)).map((node) => [node.label, node.origin]))
    // The person's words from the grandparent and the parent.
    expect(origins.get('位置编码告诉模型词序')).toMatchObject({
      basis: 'stated',
      thread: root.thread,
      turn: root.turn,
      madeIn: deep,
    })
    expect(origins.get('自注意力自己分不出先后')).toMatchObject({
      basis: 'stated',
      thread: middle,
      turn: second.turn,
      madeIn: deep,
    })
    // A model's words from the parent, read on the deepest branch.
    expect(origins.get('注意力机制看不出词序')).toMatchObject({
      basis: 'inferred',
      thread: middle,
      turn: second.reply,
      madeIn: deep,
    })
    // Said on the branch itself.
    expect(origins.get('相对位置可以代替位置编码')).toMatchObject({
      basis: 'stated',
      thread: deep,
      turn: own.turn,
    })
    expect(origins.get('相对位置可以代替位置编码')?.madeIn).toBeUndefined()
  })

  it('traces the same words to the same turn from every branch that carries them, without merging what was made', async () => {
    const space = await spaceWithNotes()
    const root = await ask(space, '我认为位置编码告诉模型词的顺序', '位置编码把序列的顺序告诉模型')
    const left = await fork(space, root.thread, root.reply)
    const right = await fork(space, root.thread, root.reply)

    // Made the person's on one branch; on the other it is already known, by the same turn.
    await accept(await offerTurn(space, left, root.turn))
    const again = await offerTurn(space, right, root.turn)
    expect(again.suggestions).toEqual([])
    expect(again.message).toBe('你已经确认过这条了。')
    const held = await nodeSaying(space, '我认为位置编码告诉模型词的顺序')
    expect(held.origin).toMatchObject({ thread: root.thread, turn: root.turn, madeIn: left })
    expect((await shown(right)).map((turn) => turn.id)).toContain(held.origin?.turn)

    // A carried answer waiting on one branch is waiting on the other too, and offering it twice changes nothing.
    expect((await offerAnswer(space, left, root.reply)).suggestions).toHaveLength(1)
    const twice = await offerAnswer(space, right, root.reply)
    expect(twice.suggestions).toEqual([])
    expect(twice.message).toBe('这条已经在待确认里了。')
    expect((await offerAnswer(space, right, root.reply)).message).toBe('这条已经在待确认里了。')
    // So is the person's own sentence, offered from the line it was said on after a branch offered it.
    const more = await ask(space, '我觉得位置编码不可省略', '注意力机制看不出词的先后', root.thread)
    const fromBranch = await fork(space, root.thread, more.turn)
    expect((await offerTurn(space, fromBranch, more.turn)).suggestions).toHaveLength(1)
    expect((await offerTurn(space, root.thread, more.turn)).message).toBe('这条已经在待确认里了。')

    // Two different readings of the same words, one on each branch: both stand, each naming its own branch.
    const distil = async (thread: string, label: string) => {
      model.thread = JSON.stringify({
        items: [{ ref: 'a', role: 'claim', label, quote: '位置编码把序列的顺序告诉模型' }],
        relations: [],
      })
      await accept((await call<Submitted>(`${scene}/candidates/thread`, { space, thread })).body)
    }
    await distil(left, '顺序信息靠位置编码进入模型')
    await distil(right, '没有位置编码模型就只看到一袋词')
    const leftNode = await nodeSaying(space, '顺序信息靠位置编码进入模型')
    const rightNode = await nodeSaying(space, '没有位置编码模型就只看到一袋词')
    expect(leftNode.nodeId).not.toBe(rightNode.nodeId)
    expect(leftNode.origin).toMatchObject({ thread: root.thread, turn: root.reply, madeIn: left })
    expect(rightNode.origin).toMatchObject({ thread: root.thread, turn: root.reply, madeIn: right })
  })

  it('reads the same origins after a restart', async () => {
    const space = await spaceWithNotes()
    const { deep, root } = await threeLevels(space)
    await accept(await offerTurn(space, deep, root.turn))
    await accept(await offerAnswer(space, deep, root.reply))
    const before = (await nodes(space)).map((node) => ({ label: node.label, origin: node.origin }))
    const trail = await proposed(
      space,
      (await nodeSaying(space, '我认为位置编码告诉模型词的顺序')).nodeId,
    )

    await service?.close()
    await start()
    const after = (await nodes(space)).map((node) => ({ label: node.label, origin: node.origin }))
    expect(after).toEqual(before)
    expect(
      after.every(({ origin }) => origin?.thread === root.thread && origin.madeIn === deep),
    ).toBe(true)
    expect(
      await proposed(space, (await nodeSaying(space, '我认为位置编码告诉模型词的顺序')).nodeId),
    ).toEqual(trail)
  })
})

describe('where an understanding came from, in a shared service', () => {
  it('gives another person nothing of the conversations behind it', async () => {
    const users = join(directory, 'users.json')
    const lin = await addPerson(users, 'Lin')
    const wei = await addPerson(users, 'Wei')
    const linHuman = await addToken(users, lin, 'human', 'workspace')
    const weiHuman = await addToken(users, wei, 'human', 'workspace')
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      mode: 'shared',
      users,
      publicOrigin: 'http://127.0.0.1',
      profile: workbenchProfile({ model }),
    })
    token = linHuman
    const space = await spaceWithNotes()
    const { root, deep } = await threeLevels(space)
    await accept(await offerTurn(space, deep, root.turn))
    const node = await nodeSaying(space, '我认为位置编码告诉模型词的顺序')
    expect(node.origin).toMatchObject({ thread: root.thread, madeIn: deep })

    // Neither the words' conversation nor the branch opens for someone else, nor does the node's trail.
    for (const thread of [root.thread, deep]) {
      expect((await call(`${scene}/session?thread=${thread}`, undefined, weiHuman)).status).toBe(
        422,
      )
    }
    const trail = await call(
      `${scene}/understanding/trail?space=${space}&node=${node.nodeId}`,
      undefined,
      weiHuman,
    )
    expect(trail.status).not.toBe(200)
    expect(JSON.stringify(trail.body)).not.toContain(root.thread)
  })
})
