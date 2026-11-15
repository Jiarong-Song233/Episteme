import { exec } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startService, type EpistemeService } from '@episteme/service'
import { SimulatedModel, workbenchProfile, type Space } from '@episteme/workbench'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/** Accepting a candidate and saving a learning answer persist through the workbench's real REST routes. */

const scene = '/scene/workbench'
const NOTES = `# 位置编码

位置编码把序列的顺序告诉模型。没有它，注意力机制看不出词的先后。

# 自注意力

注意力机制让词元根据查询和键的相似度加权。
`

interface Reply<T> {
  readonly status: number
  readonly body: T
}

interface State {
  readonly nodes: readonly { readonly nodeId: string; readonly label: string }[]
  readonly pending: readonly {
    readonly id: string
    readonly proposal: { readonly label?: string }
  }[]
}

interface Turn {
  readonly id: string
  readonly speaker: 'learner' | 'agent'
  readonly text: string
}

let directory: string
let graph: string
let built: string
let service: EpistemeService
let running = false

async function call<T>(path: string, body?: unknown): Promise<Reply<T>> {
  const response = await fetch(`${service.apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(service.humanToken === undefined
        ? {}
        : { authorization: `Bearer ${service.humanToken}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = (await response.json().catch(() => ({}))) as T
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${JSON.stringify(payload)}`)
  return { status: response.status, body: payload }
}

const stateOf = (space: string): Promise<State> =>
  call<State>(`${scene}/understanding?space=${space}`).then((reply) => reply.body)

const pageOf = (): Promise<string> => fetch(`${service.url}/`).then((reply) => reply.text())

const start = async (): Promise<void> => {
  service = await startService({
    graph,
    port: 0,
    profile: workbenchProfile({ model: new SimulatedModel() }),
    workspace: built,
  })
  running = true
}

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), 'episteme-vision-routes-'))
  await promisify(exec)(
    `pnpm --filter @episteme/workbench-web exec vite build --outDir "${built}" --emptyOutDir`,
  )
}, 180_000)

afterAll(async () => {
  await rm(built, { recursive: true, force: true, maxRetries: 5 })
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-vision-state-'))
  graph = join(directory, 'graph.db')
  await start()
}, 60_000)

afterEach(async () => {
  if (running) await service.close()
  running = false
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('published workbench decisions', () => {
  it('keeps an accepted candidate and a saved learning answer after refresh and restart', async () => {
    const { body: created } = await call<{ space: Space }>(`${scene}/spaces`, {
      name: '机器学习基础',
    })
    const space = created.space
    await call(`${scene}/materials`, {
      space: space.id,
      fileName: '编码笔记.md',
      contentBase64: Buffer.from(NOTES).toString('base64'),
    })

    const asked = await call<{ thread: string; reply: string }>(`${scene}/ask`, {
      space: space.id,
      question: '位置编码有什么用',
    })
    const offered = await call<{ suggestions: readonly { id: string }[] }>(`${scene}/candidates`, {
      space: space.id,
      thread: asked.body.thread,
      reply: asked.body.reply,
    })
    const suggestion = offered.body.suggestions[0]
    if (suggestion === undefined) throw new Error(JSON.stringify(offered.body))
    const beforeDecision = await stateOf(space.id)
    expect(beforeDecision.nodes).toEqual([])
    expect(beforeDecision.pending).toHaveLength(1)
    const candidateLabel = beforeDecision.pending[0]?.proposal.label
    if (candidateLabel === undefined) throw new Error('The candidate has no label')

    const planned = await call<{ plan: { id: string; thread: string } }>(`${scene}/plans`, {
      space: space.id,
      topic: '位置编码',
      minutes: 30,
      workflow: 'deep',
    })
    await call(`${scene}/plans/act`, { plan: planned.body.plan.id, action: 'begin' })
    await call(`${scene}/plans/act`, { plan: planned.body.plan.id, action: 'next' })
    const answer = '位置编码把先后顺序告诉模型'
    await call(`${scene}/plans/act`, {
      plan: planned.body.plan.id,
      action: 'reply',
      text: answer,
    })
    const session = await call<{ turns: readonly Turn[] }>(
      `${scene}/session?thread=${planned.body.plan.thread}`,
    )
    expect(
      session.body.turns.some((turn) => turn.speaker === 'learner' && turn.text === answer),
    ).toBe(true)

    const firstPage = await pageOf()
    expect(firstPage).toContain('id="root"')
    expect(firstPage).toContain('type="module"')

    await call('/suggestions/decide', { id: suggestion.id, action: 'accept' })
    const afterAccept = await stateOf(space.id)
    expect(afterAccept).not.toEqual(beforeDecision)
    expect(afterAccept.pending).toEqual([])
    expect(afterAccept.nodes.some((node) => node.label === candidateLabel)).toBe(true)

    const beforeSave = await stateOf(space.id)
    await call('/nodes', {
      label: answer,
      kind: 'claim',
      scope: `workbench:${space.id}`,
    })
    const afterSave = await stateOf(space.id)
    expect(afterSave).not.toEqual(beforeSave)
    expect(afterSave.nodes.some((node) => node.label === answer)).toBe(true)

    const refreshed = await pageOf()
    expect(refreshed).toContain('id="root"')
    expect(refreshed).toContain('type="module"')
    expect(refreshed).not.toContain('404')

    const labelsBeforeRestart = afterSave.nodes.map((node) => node.label).sort()
    await service.close()
    running = false
    await start()

    const restored = await stateOf(space.id)
    expect(restored.nodes.map((node) => node.label).sort()).toEqual(labelsBeforeRestart)
    expect(restored.pending).toEqual([])
    const restartedPage = await pageOf()
    expect(restartedPage).toContain('id="root"')
    const spaces = await call<{ spaces: readonly Space[] }>(`${scene}/spaces`)
    expect(spaces.body.spaces.some((entry) => entry.id === space.id)).toBe(true)
    const restartedSession = await call<{ turns: readonly Turn[] }>(
      `${scene}/session?thread=${planned.body.plan.thread}`,
    )
    expect(
      restartedSession.body.turns.some(
        (turn) => turn.speaker === 'learner' && turn.text === answer,
      ),
    ).toBe(true)
  }, 120_000)
})
