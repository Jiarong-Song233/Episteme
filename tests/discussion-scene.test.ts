import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discussionProfile, startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The discussion scene: a position is proposed, confirmed, and how far people agree is recorded, so the
 * disagreement stays recallable after the thread itself is over.
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
  directory = await mkdtemp(join(tmpdir(), 'episteme-discussion-'))
  service = await startService({
    port: 0,
    graph: join(directory, 'discussion.db'),
    profile: discussionProfile(),
  })
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

describe('the discussion scene', () => {
  it('is the scene the service reports', async () => {
    const state = await get('/api/v1/state')
    expect(state.body['scene']).toBe('discussion')
  })

  it('proposes a position, records how far people agreed, and recalls it', async () => {
    const proposed = await post('/api/v1/scene/discussion/notes', {
      text: '共享一个图谱比每个场景各自存一份更可取',
      why: '讨论：分叉会导致修正无法互相传播',
    })
    expect(proposed.status).toBe(200)
    const suggestionId = proposed.body['suggestionId'] as string

    expect(
      (await post('/api/v1/suggestions/decide', { id: suggestionId, action: 'accept' })).status,
    ).toBe(200)

    const before = await get('/api/v1/scene/discussion/notes')
    const position = (
      before.body['notes'] as readonly { nodeId: string; label: string; agreement?: string }[]
    ).find((item) => item.label.includes('共享一个图谱'))
    expect(position).toBeDefined()
    expect(position?.agreement).toBeUndefined()

    const recorded = await post('/api/v1/record', {
      target: position?.nodeId,
      dimensions: { agreement: 'partial' },
      reason: '记录讨论中的一致程度',
    })
    expect(recorded.status).toBe(200)

    const after = await get('/api/v1/scene/discussion/notes')
    const settled = (after.body['notes'] as readonly { nodeId: string; agreement?: string }[]).find(
      (item) => item.nodeId === position?.nodeId,
    )
    expect(settled?.agreement).toBe('partial')

    const recalled = await post('/api/v1/recall', { question: '共享一个图谱' })
    const ranked = recalled.body['ranked'] as readonly { nodeId: string }[]
    expect(ranked.some((item) => item.nodeId === position?.nodeId)).toBe(true)
  })

  it('refuses an agreement level it does not register', async () => {
    const created = await post('/api/v1/nodes', { label: '一个立场' })
    const node = created.body['node'] as { nodeId: string }
    const refused = await post('/api/v1/record', {
      target: node.nodeId,
      dimensions: { agreement: 'everyone' },
    })
    expect(refused.status).toBe(422)
    expect(typeof refused.body['code']).toBe('string')
  })
})
