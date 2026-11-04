import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type EpistemeService } from '@episteme/service'
import {
  ModelFailure,
  SimulatedModel,
  workbenchProfile,
  type Answer,
  type ModelClient,
  type Space,
} from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

interface Reply<T> {
  readonly status: number
  readonly body: T & { readonly code?: string; readonly error?: string }
}

let directory: string
let graph: string
let service: EpistemeService

const start = async (model: ModelClient = new SimulatedModel()): Promise<void> => {
  service = await startService({ graph, port: 0, profile: workbenchProfile({ model }) })
}

async function call<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  token = service.humanToken ?? '',
): Promise<Reply<T>> {
  const response = await fetch(`${service.apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as Reply<T>['body'] }
}

const scene = '/scene/workbench'

async function newSpace(name = '机器学习'): Promise<Space> {
  return (await call<{ space: Space }>(`${scene}/spaces`, { name })).body.space
}

const upload = (space: string, fileName: string, content: string | Uint8Array) =>
  call<{ id: string; duplicate: boolean; materials: readonly { title: string }[] }>(
    `${scene}/materials`,
    {
      space,
      fileName,
      contentBase64: Buffer.from(content).toString('base64'),
    },
  )

const ask = (space: string, question: string, extra: Record<string, unknown> = {}) =>
  call<{
    thread: string
    turn: string
    reply?: string
    answer?: Answer
    failure?: { code: string; retryable: boolean }
  }>(`${scene}/ask`, { space, question, ...extra })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-workbench-'))
  graph = join(directory, 'graph.db')
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('a learner in the workbench', () => {
  it('goes from an empty space to accepted understanding, and finds it all after a restart', async () => {
    await start()
    const space = await newSpace()
    await upload(space.id, '编码笔记.md', '# 位置\n\n位置编码把序列的顺序告诉模型。\n')

    const first = await ask(space.id, '位置编码有什么用')
    expect(first.status).toBe(200)
    expect(first.body.answer?.status).toBe('answered')
    expect(first.body.answer?.citations[0]).toMatchObject({ title: '编码笔记.md', line: 1 })

    // Nothing is the person's understanding yet.
    const before = await call<{ nodes: unknown[]; pending: unknown[] }>(
      `${scene}/understanding?space=${space.id}`,
    )
    expect(before.body.nodes).toEqual([])
    expect(before.body.pending).toEqual([])

    const candidates = await call<{ suggestions: { id: string }[] }>(`${scene}/candidates`, {
      space: space.id,
      thread: first.body.thread,
      reply: first.body.reply,
    })
    expect(candidates.status).toBe(200)
    expect(candidates.body.suggestions).toHaveLength(1)

    // A candidate is pending, and still no understanding, until the person says so.
    const pending = await call<{ nodes: unknown[]; pending: { id: string; basis: string }[] }>(
      `${scene}/understanding?space=${space.id}`,
    )
    expect(pending.body.nodes).toEqual([])
    expect(pending.body.pending[0]?.basis).toBe('inferred')

    const decided = await call('/suggestions/decide', {
      id: candidates.body.suggestions[0]?.id,
      action: 'accept',
    })
    expect(decided.status).toBe(200)
    const accepted = await call<{ nodes: { nodeId: string; label: string }[] }>(
      `${scene}/understanding?space=${space.id}`,
    )
    expect(accepted.body.nodes[0]?.label).toContain('位置编码')

    await service.close()
    await start()

    expect((await call<{ spaces: Space[] }>(`${scene}/spaces`)).body.spaces[0]?.name).toBe(
      '机器学习',
    )
    const kept = await call<{ materials: { title: string }[] }>(
      `${scene}/materials?space=${space.id}`,
    )
    expect(kept.body.materials[0]?.title).toBe('编码笔记.md')
    const sessions = await call<{ sessions: { id: string }[] }>(
      `${scene}/sessions?space=${space.id}`,
    )
    expect(sessions.body.sessions.map((thread) => thread.id)).toEqual([first.body.thread])
    const session = await call<{
      turns: { speaker: string; text: string; answer?: Answer }[]
    }>(`${scene}/session?thread=${first.body.thread}`)
    expect(session.body.turns.map((turn) => turn.speaker)).toEqual(['learner', 'agent'])
    expect(session.body.turns[1]?.answer?.citations[0]?.title).toBe('编码笔记.md')
    const restored = await call<{ nodes: { label: string }[] }>(
      `${scene}/understanding?space=${space.id}`,
    )
    expect(restored.body.nodes[0]?.label).toContain('位置编码')
    // And a question after the restart still finds the material.
    expect((await ask(space.id, '位置编码有什么用')).body.answer?.status).toBe('answered')
  })

  it('refuses a decision from an agent, and a candidate never decides itself', async () => {
    await start()
    const space = await newSpace()
    await upload(space.id, 'a.txt', '位置编码把序列的顺序告诉模型。')
    const asked = await ask(space.id, '位置编码')
    const { body } = await call<{ suggestions: { id: string }[] }>(`${scene}/candidates`, {
      space: space.id,
      thread: asked.body.thread,
      reply: asked.body.reply,
    })
    const refused = await call(
      '/suggestions/decide',
      { id: body.suggestions[0]?.id, action: 'accept' },
      'not-a-token',
    )
    expect(refused.status).toBeGreaterThanOrEqual(401)
    expect(
      (await call<{ nodes: unknown[] }>(`${scene}/understanding?space=${space.id}`)).body.nodes,
    ).toEqual([])
  })

  it('offers no candidates from an answer with nothing to rest on', async () => {
    const opinionated: ModelClient = {
      name: 'm',
      simulated: false,
      complete: () => Promise.resolve({ text: '我觉得这很重要。[推断]' }),
    }
    await start(opinionated)
    const space = await newSpace()
    await upload(space.id, 'a.txt', '位置编码把序列的顺序告诉模型。')
    const asked = await ask(space.id, '位置编码')
    expect(asked.body.answer?.status).toBe('inference_only')
    const candidates = await call<{ suggestions: unknown[] }>(`${scene}/candidates`, {
      space: space.id,
      thread: asked.body.thread,
      reply: asked.body.reply,
    })
    expect(candidates.body.suggestions).toEqual([])
  })
})

describe('conversations', () => {
  it('carries a follow-up with the question before it', async () => {
    const seen: string[][] = []
    const model: ModelClient = {
      name: 'm',
      simulated: false,
      complete(messages) {
        seen.push(messages.map((message) => message.content))
        return Promise.resolve({ text: '位置编码把序列的顺序告诉模型。[1]' })
      },
    }
    await start(model)
    const space = await newSpace()
    await upload(space.id, 'a.txt', '位置编码把序列的顺序告诉模型。')
    const first = await ask(space.id, '位置编码有什么用')
    const second = await ask(space.id, '为什么', { thread: first.body.thread })
    expect(second.body.thread).toBe(first.body.thread)
    expect(second.body.answer?.status).toBe('answered')
    expect(seen[1]).toContain('位置编码有什么用')
  })

  it('keeps the question when a model fails, and answers it once on retry', async () => {
    let fail = true
    const failing: ModelClient = {
      name: 'm',
      simulated: false,
      complete: () =>
        fail
          ? Promise.reject(new ModelFailure('timeout', '超时'))
          : Promise.resolve({ text: '位置编码把序列的顺序告诉模型。[1]' }),
    }
    await start(failing)
    const space = await newSpace()
    await upload(space.id, 'a.txt', '位置编码把序列的顺序告诉模型。')

    const failed = await ask(space.id, '位置编码有什么用')
    expect(failed.status).toBe(200)
    expect(failed.body.failure).toMatchObject({ code: 'timeout', retryable: true })
    const kept = await call<{ turns: { speaker: string }[] }>(
      `${scene}/session?thread=${failed.body.thread}`,
    )
    expect(kept.body.turns.map((turn) => turn.speaker)).toEqual(['learner'])

    fail = false
    const retried = await ask(space.id, '位置编码有什么用', {
      thread: failed.body.thread,
      retry: true,
    })
    expect(retried.body.answer?.status).toBe('answered')
    const after = await call<{ turns: { speaker: string }[] }>(
      `${scene}/session?thread=${failed.body.thread}`,
    )
    expect(after.body.turns.map((turn) => turn.speaker)).toEqual(['learner', 'agent'])
  })

  it('does not answer into another space, or a conversation that is not there', async () => {
    await start()
    const one = await newSpace('一')
    const two = await newSpace('二')
    await upload(one.id, 'a.txt', '位置编码把序列的顺序告诉模型。')
    const asked = await ask(one.id, '位置编码')
    const crossed = await ask(two.id, '位置编码', { thread: asked.body.thread })
    expect(crossed.status).toBe(422)
    expect(crossed.body.code).toBe('unknown_thread')
    expect((await ask(two.id, '位置编码')).body.answer?.status).toBe('insufficient_evidence')
    expect((await ask('sp_none', '位置编码')).body.code).toBe('unknown_space')
  })
})

describe('material through the API', () => {
  it('says why a file is refused', async () => {
    await start()
    const space = await newSpace()
    const refused = await upload(space.id, 'a.docx', 'x')
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe('unsupported_type')
    expect(refused.body.error).toContain('.txt')
    const scan = await upload(space.id, 'a.pdf', 'not a pdf')
    expect(scan.body.code).toBe('pdf_unreadable')
  })

  it('takes an upload larger than the usual body limit', async () => {
    await start()
    const space = await newSpace()
    const large = `${'位置编码把序列的顺序告诉模型。'.repeat(60_000)}`
    const { status, body } = await upload(space.id, 'large.txt', large)
    expect(status).toBe(200)
    expect(body.duplicate).toBe(false)
  }, 30_000)

  it('dedupes, deletes, and stops citing what was deleted while old answers stay readable', async () => {
    await start()
    const space = await newSpace()
    const { body: added } = await upload(space.id, 'a.txt', '位置编码把序列的顺序告诉模型。')
    expect((await upload(space.id, 'b.txt', '位置编码把序列的顺序告诉模型。')).body.duplicate).toBe(
      true,
    )
    const asked = await ask(space.id, '位置编码')
    expect(asked.body.answer?.citations).toHaveLength(1)

    expect((await call(`${scene}/materials/delete`, { id: added.id })).status).toBe(200)
    expect((await ask(space.id, '位置编码')).body.answer?.status).toBe('insufficient_evidence')
    const old = await call<{ turns: { answer?: Answer }[] }>(
      `${scene}/session?thread=${asked.body.thread}`,
    )
    expect(old.body.turns[1]?.answer?.citations[0]?.quote).toContain('位置编码')
    const gone = await call(`${scene}/material?id=${added.id}`)
    expect(gone.status).toBe(422)
    expect((await call(`${scene}/materials/delete`, { id: added.id })).status).toBe(422)
  })

  it('answers from the new content after a material is replaced', async () => {
    await start()
    const space = await newSpace()
    const { body: added } = await upload(space.id, 'a.txt', '位置编码把序列的顺序告诉模型。')
    const replaced = await call<{ version: number }>(`${scene}/materials/replace`, {
      id: added.id,
      fileName: 'a.txt',
      contentBase64: Buffer.from('注意力机制让词元彼此关联。').toString('base64'),
    })
    expect(replaced.body.version).toBe(2)
    expect((await ask(space.id, '位置编码')).body.answer?.status).toBe('insufficient_evidence')
    expect((await ask(space.id, '注意力机制')).body.answer?.status).toBe('answered')
  })
})

describe('spaces', () => {
  it('renames and archives, and an archived space takes nothing new but keeps what it has', async () => {
    await start()
    const space = await newSpace()
    await upload(space.id, 'a.txt', '位置编码把序列的顺序告诉模型。')
    const renamed = await call<{ space: Space }>(`${scene}/spaces/update`, {
      space: space.id,
      name: '新名字',
    })
    expect(renamed.body.space.name).toBe('新名字')
    await call(`${scene}/spaces/update`, { space: space.id, archived: true })
    expect((await ask(space.id, '位置编码')).body.code).toBe('space_archived')
    expect((await upload(space.id, 'b.txt', '别的内容')).body.code).toBe('space_archived')
    const kept = await call<{ materials: unknown[] }>(`${scene}/materials?space=${space.id}`)
    expect(kept.body.materials).toHaveLength(1)
    await call(`${scene}/spaces/update`, { space: space.id, archived: false })
    expect((await ask(space.id, '位置编码')).body.answer?.status).toBe('answered')
  })

  it('refuses a blank name', async () => {
    await start()
    const refused = await call(`${scene}/spaces`, { name: '   ' })
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe('invalid_request')
  })
})
