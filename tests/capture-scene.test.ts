import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addPerson,
  addToken,
  captureProfile,
  startService,
  type EpistemeService,
} from '@episteme/service'
import { afterEach, beforeEach, expect, it } from 'vitest'

let directory: string
let service: EpistemeService | undefined
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ep-capture-'))
})
afterEach(async () => {
  await service?.close()
  await rm(directory, { recursive: true, force: true })
})
async function api(path: string, body?: unknown, token?: string) {
  const response = await fetch(`${service!.apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

it('keeps three scenes in one file, with sources and exact lists, after restarting', async () => {
  const graph = join(directory, 'capture.db')
  service = await startService({ port: 0, graph, profile: captureProfile() })
  for (const [scene, text] of [
    ['dev', 'SQLite uses one database file'],
    ['learn', 'SQLite transactions are atomic'],
    ['discussion', 'SQLite has tradeoffs for a shared graph'],
  ]) {
    const note = await api(`/scene/capture/${scene}/notes`, { text, source: `fixture:${scene}` })
    expect(note.status).toBe(200)
    expect(typeof note.body['sourceId']).toBe('string')
    const accepted = await api(
      '/suggestions/decide',
      { id: note.body['suggestionId'], action: 'accept' },
      service.humanToken,
    )
    expect(accepted.status).toBe(200)
  }
  await service.close()
  service = await startService({ port: 0, graph, profile: captureProfile() })
  for (const scene of ['dev', 'learn', 'discussion']) {
    const notes = await api(`/scene/capture/${scene}/notes`)
    const list = notes.body['notes'] as { nodeId: string; scene: string }[]
    expect(list).toHaveLength(1)
    expect(list[0]?.scene).toBe(scene)
    const detail = await api(`/nodes/${list[0]!.nodeId}`)
    expect(detail.status).toBe(200)
    expect(detail.body['node']).toHaveProperty('origin')
  }
  const recall = await api('/recall', { question: 'SQLite', scope: 'scene:learn' })
  // Scope is a ranking preference, not an isolation wall (ADR 0015).
  expect(recall.body['ranked']).toHaveLength(3)
})

it('lets a real agent propose with a source, while only the person decides', async () => {
  const users = join(directory, 'users.json')
  const actor = await addPerson(users, 'Capture owner')
  const human = await addToken(users, actor, 'human', 'review')
  const agent = await addToken(users, actor, 'agent', 'capture-agent')
  service = await startService({
    port: 0,
    graph: join(directory, 'shared.db'),
    profile: captureProfile(),
    mode: 'shared',
    users,
    publicOrigin: 'http://127.0.0.1',
  })
  const proposed = await api(
    '/scene/capture/dev/notes',
    { text: 'A unique writer prevents conflicting updates' },
    agent,
  )
  expect(proposed.status).toBe(200)
  const id = proposed.body['suggestionId']
  expect((await api('/suggestions/decide', { id, action: 'accept' }, agent)).status).toBe(403)
  expect((await api('/suggestions/decide', { id, action: 'accept' }, human)).status).toBe(200)
  expect((await api('/scene/capture/dev/notes', undefined, agent)).body['notes']).toHaveLength(1)
})

it('refuses a mismatched scope and a long note without creating any proposal', async () => {
  service = await startService({
    port: 0,
    graph: join(directory, 'capture.db'),
    profile: captureProfile(),
  })
  expect(
    (await api('/scene/capture/dev/notes', { text: 'A scoped note', scope: 'scene:learn' })).status,
  ).toBe(422)
  expect((await api('/scene/capture/dev/notes', { text: 'x'.repeat(1001) })).status).toBe(422)
  expect((await api('/suggestions')).body['suggestions']).toHaveLength(0)
})
