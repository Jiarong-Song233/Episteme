import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import {
  GraphExportError,
  exportGraph,
  importGraph,
  openSqliteStorage,
  readGraphExport,
} from '@episteme/storage-sqlite'
import { SimulatedModel, workbenchProfile } from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Backing up means nothing until coming back works, so these go all the way: real conversations and material through
 * the workbench, out to a file, into a new graph, and read back through the same routes.
 */

const NOTES = '# 位置编码\n\n位置编码把序列的顺序告诉模型。\n'
const OPTIONS = { build: 'test-build' }

interface Everything {
  readonly materials: unknown
  readonly understanding: { readonly nodes: readonly unknown[] }
  readonly conversations: readonly unknown[]
  readonly trails: readonly unknown[]
}

describe('exporting and importing a graph', () => {
  let directory: string
  let graph: string
  let archive: string

  const withWorkbench = async <T>(
    file: string,
    work: (scene: <R>(path: string, body?: unknown) => Promise<R>) => Promise<T>,
  ): Promise<T> => {
    const service: EpistemeService = await startService({
      graph: file,
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel() }),
    })
    const scene = async <R>(path: string, body?: unknown): Promise<R> => {
      const response = await fetch(`${service.apiUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${service.humanToken ?? ''}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      expect(response.status).toBe(200)
      return (await response.json()) as R
    }
    try {
      return await work(scene)
    } finally {
      await service.close()
    }
  }

  /** What a person has after a short session: a space, material, a question, and something accepted. */
  const session = async (): Promise<{ space: string }> =>
    withWorkbench(graph, async (call) => {
      const { space } = await call<{ space: { id: string } }>('/scene/workbench/spaces', {
        name: '机器学习',
      })
      await call('/scene/workbench/materials', {
        space: space.id,
        fileName: '笔记.md',
        contentBase64: Buffer.from(NOTES).toString('base64'),
      })
      const asked = await call<{ thread: string; turn: string }>('/scene/workbench/ask', {
        space: space.id,
        question: '位置编码有什么用',
      })
      const offered = await call<{ suggestions: readonly { id: string }[] }>(
        '/scene/workbench/candidates/turn',
        { space: space.id, thread: asked.thread, turn: asked.turn },
      )
      for (const { id } of offered.suggestions) {
        await call('/suggestions/decide', { id, action: 'accept' })
      }
      return { space: space.id }
    })

  // The epoch names a run of the service, so it differs between any two runs and says nothing about the data.
  const steady = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (key, kept: unknown) => (key === 'epoch' ? undefined : kept)))

  const everything = async (space: string, file: string): Promise<Everything> =>
    withWorkbench(file, async (call) => {
      const sessions = await call<{ sessions: readonly { id: string }[] }>(
        `/scene/workbench/sessions?space=${space}`,
      )
      const understanding = await call<{ nodes: readonly { nodeId: string }[] }>(
        `/scene/workbench/understanding?space=${space}`,
      )
      return steady({
        materials: await call(`/scene/workbench/materials?space=${space}`),
        understanding,
        conversations: await Promise.all(
          sessions.sessions.map(({ id }) => call(`/scene/workbench/session?thread=${id}`)),
        ),
        // Where each thing came from has to survive too, not only the thing.
        trails: await Promise.all(
          understanding.nodes.map(({ nodeId }) =>
            call(`/scene/workbench/understanding/trail?space=${space}&node=${nodeId}`),
          ),
        ),
      }) as Everything
    })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-export-'))
    graph = join(directory, 'graph.db')
    archive = join(directory, 'graph.episteme.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  })

  it('brings a person’s material, conversations and understanding back into a new graph', async () => {
    const { space } = await session()
    const before = await everything(space, graph)
    expect(before.understanding.nodes.length).toBeGreaterThan(0)
    expect(before.conversations).toHaveLength(1)
    expect(before.trails).toHaveLength(before.understanding.nodes.length)
    expect(JSON.stringify(before.materials)).toContain('笔记.md')

    const exported = await exportGraph(graph, archive, OPTIONS)
    expect(exported.source).toEqual({ file: 'graph.db', build: 'test-build' })
    expect(exported.counts.records).toBeGreaterThan(0)
    const materials = Object.entries(exported.counts.companions).find(([name]) =>
      name.endsWith('materials'),
    )
    expect(materials?.[1]).toBeGreaterThan(0)
    // Where it sat on this machine does not travel.
    expect(await readFile(archive, 'utf8')).not.toContain(directory.replaceAll('\\', '\\\\'))

    const restored = join(directory, 'restored.db')
    await importGraph(archive, restored)
    expect(await everything(space, restored)).toEqual(before)

    // The original is untouched and the two no longer share anything.
    expect(await everything(space, graph)).toEqual(before)
    expect((await readdir(directory)).filter((name) => name.includes('importing'))).toEqual([])
  }, 60_000)

  it('keeps what was published, and who may read it, on a shared workbench', async () => {
    const users = join(directory, 'users.json')
    const person = async (name: string) => {
      const id = await addPerson(users, name)
      return { id, token: await addToken(users, id, 'human', 'workbench') }
    }
    const lin = await person('林')
    const wei = await person('魏')
    const shared = async <T>(file: string, work: (service: EpistemeService) => Promise<T>) => {
      const service = await startService({
        port: 0,
        graph: file,
        profile: workbenchProfile({ model: new SimulatedModel() }),
        mode: 'shared',
        users,
        publicOrigin: 'https://workbench.example.edu',
        sharing: true,
      })
      try {
        return await work(service)
      } finally {
        await service.close()
      }
    }
    const as = async <T>(
      service: EpistemeService,
      who: { token: string },
      path: string,
      body?: unknown,
    ): Promise<T> => {
      const response = await fetch(`${service.apiUrl}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      })
      expect(response.status).toBe(200)
      return (await response.json()) as T
    }
    const WORDS = '位置编码是必需的，因为注意力不看顺序'

    const publication = await shared(graph, async (service) => {
      const made = await as<{ space: { id: string } }>(service, lin, '/scene/workbench/spaces', {
        name: 'Transformer',
      })
      const opened = await as<{ thread: { id: string } }>(service, lin, '/threads', {
        title: '笔记',
        scope: `workbench:${made.space.id}`,
      })
      const turn = await as<{ turn: { id: string } }>(
        service,
        lin,
        `/threads/${opened.thread.id}/turns`,
        { speaker: 'learner', text: WORDS },
      )
      const offered = await as<{ suggestions: readonly { id: string }[] }>(
        service,
        lin,
        '/scene/workbench/candidates/turn',
        { space: made.space.id, thread: opened.thread.id, turn: turn.turn.id },
      )
      for (const { id } of offered.suggestions) {
        await as(service, lin, '/suggestions/decide', { id, action: 'accept' })
      }
      const held = await as<{ nodes: readonly { nodeId: string }[] }>(
        service,
        lin,
        `/scene/workbench/understanding?space=${made.space.id}`,
      )
      const published = await as<{ publication: { id: string } }>(service, lin, '/publications', {
        root: held.nodes[0]?.nodeId,
      })
      return published.publication.id
    })

    await exportGraph(graph, archive, OPTIONS)
    const restored = join(directory, 'restored.db')
    await importGraph(archive, restored)

    await shared(restored, async (service) => {
      const seen = await as<unknown>(service, wei, `/publications/${publication}`)
      expect(JSON.stringify(seen)).toContain(WORDS)
    })
  }, 60_000)

  it('gives the same file back for the same graph, so a round trip loses nothing', async () => {
    await session()
    await exportGraph(graph, archive, { ...OPTIONS, now: () => new Date(0) })
    const restored = join(directory, 'restored.db')
    await importGraph(archive, restored)
    const second = join(directory, 'second.episteme.json')
    await exportGraph(restored, second, { ...OPTIONS, now: () => new Date(0) })
    const first = await readGraphExport(archive)
    const again = await readGraphExport(second)
    expect(again.sha256).toBe(first.sha256)
  }, 60_000)

  // Windows ignores the mode, and CI's Linux runners are what check it.
  it.skipIf(process.platform === 'win32')(
    'writes a file only its owner can read, whatever the umask allows',
    async () => {
      await session()
      const before = process.umask(0)
      try {
        await exportGraph(graph, archive, OPTIONS)
      } finally {
        process.umask(before)
      }
      expect((await stat(archive)).mode & 0o777).toBe(0o600)
    },
    60_000,
  )

  it('takes an edited file whose checksum was recomputed, so the checksum proves no authorship', async () => {
    await session()
    await exportGraph(graph, archive, OPTIONS)
    const original = await readGraphExport(archive)
    const { records } = original
    const companions = original.companions.map((each) => ({
      ...each,
      body: each.body.replaceAll('位置编码', '换过的词'),
    }))
    expect(JSON.stringify(companions)).toContain('换过的词')
    const edited = join(directory, 'edited.episteme.json')
    await writeFile(
      edited,
      JSON.stringify({
        ...original,
        companions,
        sha256: createHash('sha256').update(JSON.stringify({ records, companions })).digest('hex'),
      }),
    )
    const restored = join(directory, 'restored.db')
    await importGraph(edited, restored)
    const again = join(directory, 'again.episteme.json')
    await exportGraph(restored, again, OPTIONS)
    expect(JSON.stringify((await readGraphExport(again)).companions)).toContain('换过的词')
  }, 60_000)

  it('refuses a graph someone is using', async () => {
    const storage = await openSqliteStorage(graph)
    try {
      await expect(exportGraph(graph, archive, OPTIONS)).rejects.toThrow(/already open/)
      expect(existsSync(archive)).toBe(false)
    } finally {
      await storage.close()
    }
  })

  const refusal = async (work: Promise<unknown>): Promise<string> => {
    const error = await work.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(GraphExportError)
    return (error as GraphExportError).code
  }

  it('never replaces anything', async () => {
    await session()
    await writeFile(archive, 'keep me')
    expect(await refusal(exportGraph(graph, archive, OPTIONS))).toBe('target_exists')
    expect(await readFile(archive, 'utf8')).toBe('keep me')

    const good = join(directory, 'good.json')
    await exportGraph(graph, good, OPTIONS)
    const before = await readFile(graph)
    expect(await refusal(importGraph(good, graph))).toBe('target_exists')
    expect((await readFile(graph)).equals(before)).toBe(true)
  }, 60_000)

  it('refuses what is damaged, edited, foreign or newer, and leaves nothing behind', async () => {
    await session()
    await exportGraph(graph, archive, OPTIONS)
    const original = JSON.parse(await readFile(archive, 'utf8')) as {
      version: number
      records: string[]
      storedAs: { sqliteFormat: number }
    }
    const target = join(directory, 'restored.db')

    const attempt = async (content: string): Promise<string> => {
      const file = join(directory, 'attempt.json')
      await writeFile(file, content)
      const code = await refusal(importGraph(file, target))
      expect(existsSync(target)).toBe(false)
      return code
    }

    const edited = structuredClone(original)
    edited.records[0] = `${edited.records[0]} `
    expect(await attempt(JSON.stringify(edited))).toBe('damaged')
    expect(await attempt('{"format":"something-else"}')).toBe('not_an_export')
    expect(await attempt('not json')).toBe('not_an_export')
    expect(await attempt(JSON.stringify({ ...original, version: 2 }))).toBe('unsupported_version')
    expect(
      await attempt(
        JSON.stringify({ ...original, storedAs: { ...original.storedAs, sqliteFormat: 99 } }),
      ),
    ).toBe('unsupported_version')
  }, 60_000)

  it('works from the command line, and says what the file holds', async () => {
    await session()
    const serve = resolve(import.meta.dirname, '../apps/workbench/dist/serve.js')
    const run = promisify(execFile)
    const out = await run(process.execPath, [serve, 'export', archive, '--graph', graph])
    expect(out.stdout).toContain('私人材料')
    expect(out.stdout).toContain('其他人的内容')

    const restored = join(directory, 'restored.db')
    const back = await run(process.execPath, [serve, 'import', archive, '--graph', restored])
    expect(back.stdout).toContain('graph.db')
    expect(back.stdout).toContain('无法证明内容是谁写的')
    expect(existsSync(restored)).toBe(true)

    await expect(
      run(process.execPath, [serve, 'import', archive, '--graph', restored]),
    ).rejects.toThrow()
  }, 60_000)
})
