import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { workbenchProfile, type ModelClient } from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * G4's acceptance, over HTTP, with two people on one workbench: Lin publishes, Wei cites, Wei forks, the system traces
 * Wei's version back to Lin's, and Lin's own understanding has not moved.
 */

const LINS_WORDS = '位置编码是必需的，因为注意力不看顺序'
const WEIS_WORDS = '位置信息是必需的，但不一定要用固定的位置编码'
const PRIVATE_WORDS = '这是林在自己对话里说的、从未发布的一句话'

const quiet: ModelClient = {
  name: 'none',
  simulated: true,
  complete: () => Promise.reject(new Error('this story needs no model')),
}

interface Person {
  readonly id: string
  readonly token: string
  readonly space: string
}

let directory: string
let service: EpistemeService
let lin: Person
let wei: Person

async function call<T>(path: string, who: { token: string }, body?: unknown) {
  const response = await fetch(`${service.apiUrl}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${who.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text) as T }
}

const scene = <T>(path: string, who: { token: string }, body?: unknown) =>
  call<T>(`/scene/workbench${path}`, who, body)

interface Held {
  readonly nodeId: string
  readonly label: string
  readonly author: string
  readonly revisedTo?: string
  readonly adoptedFrom?: { readonly publication: string; readonly author: string }
  readonly understanding: readonly { readonly id: string; readonly level: string }[]
  readonly relations: readonly { readonly type: string; readonly nodeId: string }[]
  readonly elsewhere: readonly {
    readonly type: string
    readonly direction: string
    readonly nodeId: string
    readonly label: string
  }[]
}

async function held(who: Person): Promise<readonly Held[]> {
  const reply = await scene<{ nodes: readonly Held[] }>(`/understanding?space=${who.space}`, who)
  return reply.body.nodes
}

async function accept(who: Person, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const decided = await call('/suggestions/decide', who, { id, action: 'accept' })
    expect(decided.status).toBe(200)
  }
}

/** A sentence of the person's own, through a real conversation turn, as the page does it. */
async function holdOwnWords(who: Person, words: string): Promise<Held> {
  const opened = await call<{ thread: { id: string } }>('/threads', who, {
    title: '笔记',
    scope: `workbench:${who.space}`,
  })
  const thread = opened.body.thread.id
  const turn = await call<{ turn: { id: string } }>(`/threads/${thread}/turns`, who, {
    speaker: 'learner',
    text: words,
  })
  const offered = await scene<{ suggestions: readonly { id: string }[] }>('/candidates/turn', who, {
    space: who.space,
    thread,
    turn: turn.body.turn.id,
  })
  await accept(
    who,
    offered.body.suggestions.map((suggestion) => suggestion.id),
  )
  const found = (await held(who)).find((node) => node.label === words)
  if (found === undefined) throw new Error(`"${words}" was not held`)
  return found
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-workbench-sharing-'))
  const users = join(directory, 'users.json')
  const person = async (name: string) => {
    const id = await addPerson(users, name)
    return { id, token: await addToken(users, id, 'human', 'workbench') }
  }
  const linId = await person('林')
  const weiId = await person('魏')
  service = await startService({
    port: 0,
    graph: join(directory, 'shared.db'),
    profile: workbenchProfile({ model: quiet }),
    mode: 'shared',
    users,
    publicOrigin: 'https://workbench.example.edu',
    sharing: true,
  })
  const spaceFor = async (who: { id: string; token: string }, name: string) => {
    const made = await scene<{ space: { id: string } }>('/spaces', who, { name })
    return { ...who, space: made.body.space.id }
  }
  lin = await spaceFor(linId, 'Transformer')
  wei = await spaceFor(weiId, '注意力')
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

async function linPublishes(): Promise<{ node: Held; publication: string }> {
  const node = await holdOwnWords(lin, LINS_WORDS)
  const published = await call<{ publication: { id: string } }>('/publications', lin, {
    root: node.nodeId,
  })
  expect(published.status).toBe(200)
  return { node, publication: published.body.publication.id }
}

async function weiCites(publication: string, node: string): Promise<void> {
  const adopted = await call(`/publications/${publication}/adopt`, wei, {
    node,
    dimensions: { confidence: 'medium' },
  })
  expect(adopted.status).toBe(200)
  const placed = await scene('/sharing/cite', wei, { space: wei.space, publication, node })
  expect(placed.status).toBe(200)
}

async function weiResponds(
  publication: string,
  node: string,
  label: string,
  relation: 'forks' | 'contradicts' | 'supports',
): Promise<void> {
  const responded = await scene<{ suggestions: readonly { id: string }[] }>(
    '/sharing/respond',
    wei,
    { space: wei.space, publication, node, label, relation, reason: '固定编码不是唯一的办法' },
  )
  expect(responded.status).toBe(200)
  expect(responded.body.suggestions).toHaveLength(2)
  await accept(
    wei,
    responded.body.suggestions.map((suggestion) => suggestion.id),
  )
}

describe('working with what someone else published', () => {
  it('keeps why someone answered private until they publish it themselves', async () => {
    const original = await linPublishes()
    await weiResponds(original.publication, original.node.nodeId, WEIS_WORDS, 'forks')
    const fork = (await held(wei)).find((node) => node.label === WEIS_WORDS)
    const lineage = `/sharing/lineage?node=${fork?.nodeId}`
    const whyFor = async (who: typeof lin) =>
      (await scene<{ steps: readonly { reason?: string }[] }>(lineage, who)).body.steps.at(-1)
        ?.reason

    const offered = await scene<{ reason?: string }>(
      `/sharing/publishable?space=${wei.space}&node=${fork?.nodeId}`,
      wei,
    )
    expect(offered.body.reason).toBe('固定编码不是唯一的办法')

    const silent = await call('/publications', wei, { root: fork?.nodeId })
    expect(silent.status).toBe(200)
    expect(await whyFor(wei)).toBe('固定编码不是唯一的办法')
    expect(await whyFor(lin)).toBeUndefined()

    const { publication } = silent.body as { publication: { id: string } }
    expect((await call(`/publications/${publication.id}/withdraw`, wei, {})).status).toBe(200)
    const spoken = await call('/publications', wei, { root: fork?.nodeId, note: '我想让林也看到' })
    expect(spoken.status).toBe(200)
    expect(await whyFor(lin)).toBe('我想让林也看到')
    const read = await scene<{ responses: readonly { note?: string }[] }>(
      `/sharing/publication?id=${original.publication}`,
      lin,
    )
    expect(read.body.responses.map((response) => response.note)).toEqual(['我想让林也看到'])
  })

  it('runs from publishing through a fork to the original, leaving the original alone', async () => {
    const original = await linPublishes()
    const before = await held(lin)

    await weiCites(original.publication, original.node.nodeId)
    const cited = (await held(wei)).find((node) => node.nodeId === original.node.nodeId)
    expect(cited).toMatchObject({
      label: LINS_WORDS,
      author: lin.id,
      adoptedFrom: { publication: original.publication, author: lin.id },
    })
    expect(cited?.understanding).toEqual([{ id: 'confidence', level: 'medium' }])

    // Wei cannot change Lin's words, only offer his own.
    const inPlace = await scene('/understanding/revise', wei, {
      space: wei.space,
      node: original.node.nodeId,
      label: WEIS_WORDS,
    })
    expect(inPlace.body).toMatchObject({ code: 'not_your_words' })
    await weiResponds(original.publication, original.node.nodeId, WEIS_WORDS, 'forks')

    const weis = await held(wei)
    const fork = weis.find((node) => node.label === WEIS_WORDS)
    expect(fork).toMatchObject({ author: wei.id })
    // For Wei his own version now stands in for what he cited.
    expect(weis.find((node) => node.nodeId === original.node.nodeId)?.revisedTo).toBe(fork?.nodeId)

    // Traceable back to the original, with who wrote each step.
    const lineage = await scene<{ steps: readonly unknown[] }>(
      `/sharing/lineage?node=${fork?.nodeId}`,
      wei,
    )
    expect(lineage.body.steps).toEqual([
      expect.objectContaining({
        nodeId: original.node.nodeId,
        author: lin.id,
        publication: original.publication,
      }),
      expect.objectContaining({ nodeId: fork?.nodeId, author: wei.id, relation: 'forks_from' }),
    ])

    // Nothing of Lin's moved: same words, same state, not revised, and no sign of a fork Wei has not published.
    expect(await held(lin)).toEqual(before)
    const seenByLin = await scene<{ responses: readonly unknown[] }>(
      `/sharing/publication?id=${original.publication}`,
      lin,
    )
    expect(seenByLin.body.responses).toEqual([])
    expect(seenByLin.text).not.toContain(WEIS_WORDS)

    // Publishing the fork carries the link to the original, and only then Lin can see it.
    const published = await call<{ publication: { id: string; edges: readonly string[] } }>(
      '/publications',
      wei,
      { root: fork?.nodeId },
    )
    expect(published.status).toBe(200)
    expect(published.body.publication.edges).toHaveLength(1)
    const answered = await scene<{ responses: readonly unknown[] }>(
      `/sharing/publication?id=${original.publication}`,
      lin,
    )
    expect(answered.body.responses).toEqual([
      expect.objectContaining({
        publication: published.body.publication.id,
        author: wei.id,
        label: WEIS_WORDS,
        relation: 'forks_from',
        target: original.node.nodeId,
      }),
    ])
    const linNow = (await held(lin)).find((node) => node.nodeId === original.node.nodeId)
    expect(linNow?.label).toBe(LINS_WORDS)
    expect(linNow?.revisedTo).toBeUndefined()
    expect(linNow?.understanding).toEqual(original.node.understanding)
    expect(linNow?.elsewhere).toEqual([
      { type: 'forks_from', direction: 'in', nodeId: fork?.nodeId, label: WEIS_WORDS },
    ])
  })

  it('names the author only for people whose work can be read', async () => {
    const before = await call<{ names: Record<string, string> }>('/me', wei)
    expect(before.body).toMatchObject({ actorId: wei.id, mode: 'shared', sharing: true })
    expect(before.body.names).toEqual({ [wei.id]: '魏' })
    await linPublishes()
    const after = await call<{ names: Record<string, string> }>('/me', wei)
    expect(after.body.names).toEqual({ [wei.id]: '魏', [lin.id]: '林' })
  })

  it('keeps the name of an author whose withdrawn work was cited', async () => {
    const original = await linPublishes()
    await weiCites(original.publication, original.node.nodeId)
    expect((await call(`/publications/${original.publication}/withdraw`, lin, {})).status).toBe(200)
    expect(
      (await call<{ publications: unknown[] }>('/publications', wei)).body.publications,
    ).toEqual([])
    const cited = await call<{ names: Record<string, string> }>('/me', wei)
    expect(cited.body.names).toEqual({ [wei.id]: '魏', [lin.id]: '林' })
  })

  it('makes public only what was published', async () => {
    await holdOwnWords(lin, PRIVATE_WORDS)
    const original = await linPublishes()
    const reads = [
      await call('/publications', wei),
      await call(`/publications/${original.publication}`, wei),
      await scene(`/sharing/publication?id=${original.publication}`, wei),
      await scene(`/understanding?space=${wei.space}`, wei),
      await call('/state', wei),
    ]
    for (const read of reads) expect(read.text).not.toContain(PRIVATE_WORDS)
    // Someone else's space is not reachable by naming it.
    const prying = await scene(`/understanding?space=${lin.space}`, wei)
    expect(prying.status).toBe(422)
  })

  it('keeps recall on the citing person’s own version, and marks what is someone else’s', async () => {
    const original = await linPublishes()
    await weiCites(original.publication, original.node.nodeId)
    const reused = (await held(wei)).find((node) => node.nodeId === original.node.nodeId)
    expect(reused?.adoptedFrom?.author).toBe(lin.id)

    await weiResponds(original.publication, original.node.nodeId, WEIS_WORDS, 'forks')
    const nodes = await held(wei)
    expect(nodes.filter((node) => node.revisedTo === undefined).map((node) => node.label)).toEqual([
      WEIS_WORDS,
    ])
  })

  it('lets a person disagree without replacing what they cited', async () => {
    const original = await linPublishes()
    await weiCites(original.publication, original.node.nodeId)
    await weiResponds(
      original.publication,
      original.node.nodeId,
      '注意力加上掩码也能表达一部分顺序',
      'contradicts',
    )
    const nodes = await held(wei)
    expect(nodes.find((node) => node.nodeId === original.node.nodeId)?.revisedTo).toBeUndefined()
    expect(nodes.filter((node) => node.revisedTo === undefined)).toHaveLength(2)
  })

  it('does not let the author’s next version change what was cited', async () => {
    const original = await linPublishes()
    await weiCites(original.publication, original.node.nodeId)

    const revised = await scene<{ suggestions: readonly { id: string }[] }>(
      '/understanding/revise',
      lin,
      { space: lin.space, node: original.node.nodeId, label: '位置信息不可少，注意力看不出顺序' },
    )
    await accept(
      lin,
      revised.body.suggestions.map((suggestion) => suggestion.id),
    )
    const newest = (await held(lin)).find((node) => node.revisedTo === undefined)
    const offer = await scene<{ earlier?: { id: string } }>(
      `/sharing/publishable?space=${lin.space}&node=${newest?.nodeId}`,
      lin,
    )
    expect(offer.body.earlier?.id).toBe(original.publication)
    const next = await call<{ publication: { id: string } }>('/publications', lin, {
      root: newest?.nodeId,
      supersedes: original.publication,
    })
    expect(next.status).toBe(200)

    const nodes = await held(wei)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ nodeId: original.node.nodeId, label: LINS_WORDS })
    expect(nodes[0]?.revisedTo).toBeUndefined()

    // He is told, and told once he has decided to stay.
    const updates = await scene<{ updates: readonly { newer: string }[] }>('/sharing/updates', wei)
    expect(updates.body.updates).toEqual([
      expect.objectContaining({
        adopted: original.publication,
        newer: next.body.publication.id,
        author: lin.id,
        added: [expect.objectContaining({ nodeId: newest?.nodeId })],
      }),
    ])
    await scene('/sharing/updates/keep', wei, { newer: next.body.publication.id })
    const quietNow = await scene<{ updates: readonly unknown[] }>('/sharing/updates', wei)
    expect(quietNow.body.updates).toEqual([])
  })

  it('keeps the trace to a withdrawn original without keeping its words', async () => {
    const original = await linPublishes()
    await weiResponds(original.publication, original.node.nodeId, WEIS_WORDS, 'forks')
    const fork = (await held(wei)).find((node) => node.label === WEIS_WORDS)
    const withdrawn = await call(`/publications/${original.publication}/withdraw`, lin, {})
    expect(withdrawn.status).toBe(200)

    const lineage = await scene<{ steps: readonly unknown[] }>(
      `/sharing/lineage?node=${fork?.nodeId}`,
      wei,
    )
    expect(lineage.text).not.toContain(LINS_WORDS)
    expect(lineage.body.steps).toEqual([
      expect.objectContaining({
        author: lin.id,
        publication: original.publication,
        withdrawn: true,
      }),
      expect.objectContaining({ nodeId: fork?.nodeId, author: wei.id }),
    ])
    const refused = await scene('/sharing/respond', wei, {
      space: wei.space,
      publication: original.publication,
      node: original.node.nodeId,
      label: '还想回应',
      relation: 'supports',
    })
    expect(refused.body).toMatchObject({ code: 'not_live' })
  })

  it('refuses to place an item the person has not adopted, or to answer their own', async () => {
    const original = await linPublishes()
    const placed = await scene('/sharing/cite', wei, {
      space: wei.space,
      publication: original.publication,
      node: original.node.nodeId,
    })
    expect(placed.body).toMatchObject({ code: 'not_adopted' })
    const own = await scene('/sharing/respond', lin, {
      space: lin.space,
      publication: original.publication,
      node: original.node.nodeId,
      label: '换个说法',
      relation: 'forks',
    })
    expect(own.body).toMatchObject({ code: 'own_publication' })
  })

  it('stays off unless it is turned on', async () => {
    await service.close()
    const users = join(directory, 'users.json')
    service = await startService({
      port: 0,
      graph: join(directory, 'private.db'),
      profile: workbenchProfile({ model: quiet }),
      mode: 'shared',
      users,
      publicOrigin: 'https://workbench.example.edu',
    })
    const me = await call('/me', wei)
    expect(me.body).toMatchObject({ sharing: false })
    const refused = await call('/publications', wei, { root: 'anything' })
    expect(refused.body).toMatchObject({ code: 'sharing_disabled' })
  })
})
