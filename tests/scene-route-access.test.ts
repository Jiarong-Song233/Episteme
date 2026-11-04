import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addPerson,
  addToken,
  startService,
  type EpistemeService,
  type SceneRoute,
} from '@episteme/service'
import { BLANK_TOPIC, type SceneProfile } from '@episteme/service'
import { learnScene } from '@episteme/application'
import { SimulatedModel, workbenchProfile } from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Who may use a scene's routes (ADR 0020): the person, an agent acting for them, someone with no credential, and
 * someone else. Reading and proposing are open to an agent; a route that deletes, archives, replaces, settles or
 * speaks for the person is not, and neither is one nobody classified.
 */

/**
 * Written out here on purpose, apart from the profile's own list: opening a route to agents has to change this too.
 */
const OPEN_TO_AGENTS = new Set([
  '/spaces',
  '/materials',
  '/plans',
  '/candidates',
  '/candidates/turn',
  '/candidates/thread',
])

const postRoutes = (): string[] =>
  (workbenchProfile({ model: new SimulatedModel() }).routes ?? [])
    .filter((route) => route.method === 'POST')
    .map((route) => route.path)

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function post(
  service: EpistemeService,
  path: string,
  body: unknown,
  token?: string,
): Promise<Reply> {
  const response = await fetch(`${service.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function get(service: EpistemeService, path: string, token?: string): Promise<Reply> {
  const response = await fetch(`${service.apiUrl}${path}`, {
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const scene = (path: string): string => `/scene/workbench${path}`
const MATERIAL = Buffer.from('合成材料：校验和不对时必须停止重放。\n').toString('base64')

interface Listed {
  readonly materials: readonly { readonly id: string }[]
}

let directory: string
let service: EpistemeService | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-scene-access-'))
})

afterEach(async () => {
  await service?.close()
  service = undefined
  await rm(directory, { recursive: true, force: true })
})

describe('in a shared deployment', () => {
  let alice: { human: string; agent: string }
  let bob: { human: string; agent: string }

  async function start(): Promise<EpistemeService> {
    const users = join(directory, 'users.json')
    const person = async (name: string): Promise<{ human: string; agent: string }> => {
      const actor = await addPerson(users, name)
      return {
        human: await addToken(users, actor, 'human', 'workspace'),
        agent: await addToken(users, actor, 'agent', 'host'),
      }
    }
    alice = await person('alice')
    bob = await person('bob')
    service = await startService({
      graph: join(directory, 'shared.db'),
      port: 0,
      mode: 'shared',
      users,
      publicOrigin: 'http://127.0.0.1:1',
      profile: workbenchProfile({ model: new SimulatedModel() }),
    })
    return service
  }

  /** A space of Alice's with one material in it, made by Alice herself. */
  async function aSpace(on: EpistemeService): Promise<{ space: string; material: string }> {
    const made = await post(on, scene('/spaces'), { name: '潮汐缓存' }, alice.human)
    const space = (made.body['space'] as { id: string }).id
    const added = await post(
      on,
      scene('/materials'),
      { space, fileName: 'm.txt', contentBase64: MATERIAL },
      alice.human,
    )
    expect(added.status).toBe(200)
    return { space, material: added.body['id'] as string }
  }

  const held = async (on: EpistemeService, space: string): Promise<readonly string[]> => {
    const listed = await get(on, scene(`/materials?space=${space}`), alice.human)
    return (listed.body as unknown as Listed).materials.map(({ id }) => id)
  }

  it('sorts every route the scene has, by who may use it', async () => {
    const on = await start()
    const routes = postRoutes()
    expect(routes.length).toBeGreaterThan(0)
    for (const path of routes) {
      const nobody = await post(on, scene(path), {})
      expect([path, nobody.status]).toEqual([path, 401])

      const agent = await post(on, scene(path), {}, alice.agent)
      if (OPEN_TO_AGENTS.has(path)) {
        expect([path, agent.status === 401 || agent.status === 403]).toEqual([path, false])
      } else {
        expect([path, agent.status, agent.body['code']]).toEqual([path, 403, 'human_required'])
      }

      const person = await post(on, scene(path), {}, alice.human)
      expect([path, person.status === 401 || person.status === 403]).toEqual([path, false])
    }
  })

  it('keeps what the owner has decided is high impact out of an agent’s reach', async () => {
    const on = await start()
    const { space, material } = await aSpace(on)

    expect((await post(on, scene('/materials/delete'), { id: material }, alice.agent)).status).toBe(
      403,
    )
    expect(await held(on, space)).toEqual([material])

    const archive = await post(on, scene('/spaces/update'), { space, archived: true }, alice.agent)
    expect(archive.status).toBe(403)
    const rename = await post(on, scene('/spaces/update'), { space, name: '被改名' }, alice.agent)
    expect(rename.status).toBe(403)
    const spaces = await get(on, scene('/spaces'), alice.human)
    expect(spaces.body['spaces']).toMatchObject([{ id: space, name: '潮汐缓存', archived: false }])

    const replaced = await post(
      on,
      scene('/materials/replace'),
      { id: material, fileName: 'm.txt', contentBase64: MATERIAL },
      alice.agent,
    )
    expect(replaced.status).toBe(403)
    expect(await held(on, space)).toEqual([material])

    // Asking is recorded as the person's own turn, so an agent cannot put a question in their mouth.
    const asked = await post(on, scene('/ask'), { space, question: '为什么？' }, alice.agent)
    expect(asked.status).toBe(403)
    const sessions = await get(on, scene(`/sessions?space=${space}`), alice.human)
    expect(sessions.status).toBe(200)
    expect(sessions.body['sessions']).toEqual([])
  })

  it('leaves confirming to the person, on the routes it always was', async () => {
    const on = await start()
    const decide = await post(
      on,
      '/suggestions/decide',
      { suggestion: 'sug_any', action: 'accept' },
      alice.agent,
    )
    expect([decide.status, decide.body['code']]).toEqual([403, 'human_required'])
  })

  it('lets an agent propose what the person can then keep or remove', async () => {
    const on = await start()
    const made = await post(on, scene('/spaces'), { name: 'Agent 开的空间' }, alice.agent)
    expect(made.status).toBe(200)
    const space = (made.body['space'] as { id: string }).id
    const added = await post(
      on,
      scene('/materials'),
      { space, fileName: 'm.txt', contentBase64: MATERIAL },
      alice.agent,
    )
    expect(added.status).toBe(200)
    const material = added.body['id'] as string

    expect(await held(on, space)).toEqual([material])
    expect((await post(on, scene('/materials/delete'), { id: material }, alice.human)).status).toBe(
      200,
    )
    expect(await held(on, space)).toEqual([])
    const archived = await post(on, scene('/spaces/update'), { space, archived: true }, alice.human)
    expect(archived.status).toBe(200)
  })

  it('does not reach across people, whichever token is used', async () => {
    const on = await start()
    const { space, material } = await aSpace(on)

    // Bob's own token is a person's, so it passes the door and finds nothing of Alice's behind it.
    const deleted = await post(on, scene('/materials/delete'), { id: material }, bob.human)
    expect([deleted.status, deleted.body['code']]).toEqual([422, 'unknown_material'])
    const archived = await post(on, scene('/spaces/update'), { space, archived: true }, bob.human)
    expect(archived.status).toBe(422)
    const added = await post(
      on,
      scene('/materials'),
      { space, fileName: 'x.txt', contentBase64: MATERIAL },
      bob.agent,
    )
    expect(added.status).toBe(422)
    const read = await get(on, scene(`/materials?space=${space}`), bob.human)
    expect(read.status).toBe(422)
    const spaces = await get(on, scene('/spaces'), bob.agent)
    expect(spaces.body['spaces']).toEqual([])

    expect(await held(on, space)).toEqual([material])
    const kept = await get(on, scene('/spaces'), alice.human)
    expect(kept.body['spaces']).toMatchObject([{ id: space, archived: false }])
  })

  it('refuses a token nobody issued the same as none', async () => {
    const on = await start()
    for (const path of postRoutes()) {
      expect((await post(on, scene(path), {}, 'ep_not_a_token')).status).toBe(401)
    }
  })

  it('closes a path that matches no route, so a variation cannot slip past', async () => {
    const on = await start()
    const { space, material } = await aSpace(on)
    for (const path of [
      '/materials/delete/',
      '//materials/delete',
      '/materials/Delete',
      '/nothing',
    ]) {
      const reply = await post(on, scene(path), { id: material }, alice.agent)
      expect([path, reply.status]).toEqual([path, 403])
    }
    expect(await held(on, space)).toEqual([material])
  })
})

describe('on one person’s machine', () => {
  beforeEach(async () => {
    service = await startService({
      graph: join(directory, 'local.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel() }),
    })
  })

  it('lets anything local read and propose without a credential, as it does over MCP', async () => {
    const on = service as EpistemeService
    const made = await post(on, scene('/spaces'), { name: '本机' })
    expect(made.status).toBe(200)
    const space = (made.body['space'] as { id: string }).id
    const added = await post(on, scene('/materials'), {
      space,
      fileName: 'm.txt',
      contentBase64: MATERIAL,
    })
    expect(added.status).toBe(200)
    expect((await get(on, scene(`/materials?space=${space}`))).status).toBe(200)
  })

  it('needs the person’s token for everything else, however the page is reached', async () => {
    const on = service as EpistemeService
    const token = on.humanToken ?? ''
    const made = await post(on, scene('/spaces'), { name: '本机' }, token)
    const space = (made.body['space'] as { id: string }).id
    const added = await post(
      on,
      scene('/materials'),
      { space, fileName: 'm.txt', contentBase64: MATERIAL },
      token,
    )
    const material = added.body['id'] as string

    for (const path of postRoutes().filter((each) => !OPEN_TO_AGENTS.has(each))) {
      expect([path, (await post(on, scene(path), { id: material, space })).status]).toEqual([
        path,
        401,
      ])
    }
    const listed = await get(on, scene(`/materials?space=${space}`))
    expect((listed.body as unknown as Listed).materials.map(({ id }) => id)).toEqual([material])
    expect((await post(on, scene('/materials/delete'), { id: material }, token)).status).toBe(200)
  })
})

describe('a scene that says nothing about its routes', () => {
  const ECHO: SceneRoute = {
    method: 'POST',
    path: '/echo',
    handle: ({ body }) => ({ echoed: body }),
  }
  const profile = (overrides: Partial<SceneProfile> = {}): SceneProfile => ({
    name: 'plain',
    seed: BLANK_TOPIC,
    scene: learnScene,
    routes: [ECHO, { method: 'GET', path: '/state', handle: () => ({ ok: true }) }],
    ...overrides,
  })

  async function start(
    overrides?: Partial<SceneProfile>,
  ): Promise<{ on: EpistemeService; agent: string; human: string }> {
    const users = join(directory, 'users.json')
    const actor = await addPerson(users, 'alice')
    const human = await addToken(users, actor, 'human', 'workspace')
    const agent = await addToken(users, actor, 'agent', 'host')
    service = await startService({
      graph: join(directory, 'plain.db'),
      port: 0,
      mode: 'shared',
      users,
      publicOrigin: 'http://127.0.0.1:1',
      profile: profile(overrides),
    })
    return { on: service, agent, human }
  }

  it('leaves its writes to the person and its reads to anyone with a credential', async () => {
    const { on, agent, human } = await start()
    expect((await post(on, '/scene/plain/echo', {}, agent)).status).toBe(403)
    expect((await post(on, '/scene/plain/echo', {}, human)).status).toBe(200)
    expect((await get(on, '/scene/plain/state', agent)).status).toBe(200)
  })

  it('opens a route to agents only by naming it', async () => {
    const { on, agent } = await start({ proposingRoutes: ['/echo'] })
    expect((await post(on, '/scene/plain/echo', { said: 1 }, agent)).status).toBe(200)
  })
})
