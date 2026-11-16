import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devProfile, startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The dev scene: a lesson is proposed, waits for the person, then becomes something recall can build on.
 *
 * The path is the same one every scene uses (ADR 0008): propose through a scene route, decide through
 * `/suggestions/decide`, record state through `/record`. What is dev-specific is the `validity` axis.
 */

interface Json {
  readonly [key: string]: unknown
}

let directory: string
let service: EpistemeService

async function get(path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${service.url}${path}`)
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${service.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.humanToken ?? ''}`,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-dev-scene-'))
  service = await startService({
    port: 0,
    graph: join(directory, 'dev.db'),
    profile: devProfile(),
  })
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

describe('the dev scene', () => {
  it('proposes a lesson, waits for the person, then recalls it with its validity', async () => {
    const proposed = await post('/api/v1/scene/dev/notes', {
      text: '用 SQLite 单文件，跨进程靠文件锁保证唯一写入',
      why: 'ADR 0018：两套后端加陈旧锁文件的成本更高',
    })
    expect(proposed.status).toBe(200)
    const suggestionId = proposed.body['suggestionId'] as string
    expect(typeof suggestionId).toBe('string')

    // It is a draft, not the person's understanding, until they decide.
    const pending = await get('/api/v1/suggestions')
    const drafts = pending.body['suggestions'] as readonly { id: string; proposedBy: string }[]
    expect(drafts.some((draft) => draft.id === suggestionId)).toBe(true)
    expect(drafts.find((draft) => draft.id === suggestionId)?.proposedBy).toBe('ep-cli')

    const decided = await post('/api/v1/suggestions/decide', {
      id: suggestionId,
      action: 'accept',
    })
    expect(decided.status).toBe(200)

    const notes = await get('/api/v1/scene/dev/notes')
    const note = (
      notes.body['notes'] as readonly { nodeId: string; label: string; validity?: string }[]
    ).find((candidate) => candidate.label.includes('SQLite'))
    expect(note).toBeDefined()
    expect(note?.validity).toBeUndefined()

    const recorded = await post('/api/v1/record', {
      target: note?.nodeId,
      dimensions: { validity: 'tested' },
      reason: '已在本地跑通',
    })
    expect(recorded.status).toBe(200)

    const after = await get('/api/v1/scene/dev/notes')
    const settled = (after.body['notes'] as readonly { nodeId: string; validity?: string }[]).find(
      (candidate) => candidate.nodeId === note?.nodeId,
    )
    expect(settled?.validity).toBe('tested')

    const recalled = await post('/api/v1/recall', { question: '为什么存储选 SQLite' })
    const ranked = recalled.body['ranked'] as readonly { nodeId: string }[]
    expect(ranked.some((item) => item.nodeId === note?.nodeId)).toBe(true)
  })

  it('refuses a validity level it does not register', async () => {
    const created = await post('/api/v1/nodes', { label: '一条自己的经验' })
    const node = created.body['node'] as { nodeId: string }
    const refused = await post('/api/v1/record', {
      target: node.nodeId,
      dimensions: { validity: 'invented-level' },
    })
    expect(refused.status).toBe(422)
    expect(typeof refused.body['code']).toBe('string')
  })
})
