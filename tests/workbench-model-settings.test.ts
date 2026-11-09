import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { ModelSettings, remoteModel, serviceModel, workbenchProfile } from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Choosing the model on the page: it is tried before it is kept, the key stays in a file beside the graph and never
 * comes back, an agent cannot change it, and a model set in the environment cannot be overridden.
 */

const KEY = 'sk-right'

let directory: string
let provider: Server
let providerUrl: string
let seen: { model: unknown; auth: unknown }[]

/** An OpenAI-compatible service that answers only with the right key. */
async function startProvider(): Promise<void> {
  seen = []
  provider = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      seen.push({ model: body['model'], auth: request.headers['authorization'] })
      if (request.headers['authorization'] !== `Bearer ${KEY}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          created: 0,
          model: body['model'],
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '好' } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-model-settings-'))
  await startProvider()
})

afterEach(async () => {
  await new Promise<void>((resolve) => provider.close(() => resolve()))
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('model settings', () => {
  let service: EpistemeService | undefined
  afterEach(async () => {
    await service?.close()
    service = undefined
  })

  async function serve(settings: ModelSettings): Promise<EpistemeService> {
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: settings, modelSettings: settings }),
    })
    return service
  }

  async function call(
    running: EpistemeService,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${running.url}/api/v1/scene/workbench${path}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it('tries a model before keeping it, and never shows the key again', async () => {
    const file = join(directory, 'model.json')
    const settings = await ModelSettings.open(file)
    const running = await serve(settings)
    const person = running.humanToken!

    expect((await call(running, '/model')).body).toMatchObject({
      simulated: true,
      source: 'none',
      hasKey: false,
    })

    const wrong = await call(
      running,
      '/model/settings',
      { baseUrl: providerUrl, model: 'm-1', apiKey: 'sk-wrong' },
      person,
    )
    expect(wrong.body).toMatchObject({ failure: { code: 'unauthorized' } })
    // The page has no environment variables to check: the message says what to fix in the form.
    expect(JSON.stringify(wrong.body)).toContain('密钥')
    expect(JSON.stringify(wrong.body)).not.toContain('EPISTEME_MODEL')
    await expect(stat(file)).rejects.toThrow()
    expect(settings.simulated).toBe(true)

    const right = await call(
      running,
      '/model/settings',
      { baseUrl: `${providerUrl}/`, model: 'm-1', apiKey: KEY },
      person,
    )
    expect(right.body['model']).toEqual({
      name: 'm-1',
      simulated: false,
      source: 'settings',
      baseUrl: providerUrl,
      model: 'm-1',
      hasKey: true,
    })
    expect(settings.simulated).toBe(false)
    const read = await call(running, '/model')
    expect(JSON.stringify(read.body)).not.toContain(KEY)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      baseUrl: providerUrl,
      model: 'm-1',
      apiKey: KEY,
    })

    // Changing the model name at the same address keeps the saved key.
    const renamed = await call(
      running,
      '/model/settings',
      { baseUrl: providerUrl, model: 'm-2' },
      person,
    )
    expect(renamed.body['model']).toMatchObject({ name: 'm-2', hasKey: true })
    expect(seen.at(-1)).toEqual({ model: 'm-2', auth: `Bearer ${KEY}` })

    // A different address never receives the saved key.
    await call(
      running,
      '/model/settings',
      { baseUrl: 'http://127.0.0.1:9/v1', model: 'm-3' },
      person,
    )
    expect(settings.name).toBe('m-2')

    const cleared = await call(running, '/model/clear', {}, person)
    expect(cleared.body['model']).toMatchObject({ simulated: true, source: 'none' })
    await expect(stat(file)).rejects.toThrow()
  }, 30_000)

  it('keeps the choice across a restart, and ignores a damaged file', async () => {
    const file = join(directory, 'model.json')
    await writeFile(file, JSON.stringify({ baseUrl: providerUrl, model: 'kept', apiKey: KEY }))
    const kept = await ModelSettings.open(file)
    expect(kept.view()).toMatchObject({ name: 'kept', source: 'settings', hasKey: true })
    expect(await kept.complete([{ role: 'user', content: 'q' }])).toMatchObject({ text: '好' })

    await writeFile(file, '{ not json')
    expect((await ModelSettings.open(file)).view()).toMatchObject({
      simulated: true,
      source: 'none',
    })
  })

  it('is the person’s: a request without their credential cannot change it', async () => {
    const settings = await ModelSettings.open(join(directory, 'model.json'))
    const running = await serve(settings)
    const refused = await call(running, '/model/settings', {
      baseUrl: providerUrl,
      model: 'm',
      apiKey: KEY,
    })
    // Without a credential, a local service lets anyone propose (a space, here) but not choose the model.
    expect((await call(running, '/spaces', { name: '提出的空间' })).status).toBe(200)
    expect(refused.status).toBe(401)
    expect((await call(running, '/model/clear', {})).status).toBe(401)
    expect(settings.simulated).toBe(true)
    expect(seen).toEqual([])
  })

  it('leaves a model set in the environment alone', async () => {
    const environment = remoteModel({ baseUrl: providerUrl, model: 'from-env', apiKey: KEY })
    const settings = await ModelSettings.open(join(directory, 'model.json'), environment)
    const running = await serve(settings)
    expect((await call(running, '/model')).body).toMatchObject({
      name: 'from-env',
      simulated: false,
      source: 'environment',
      hasKey: false,
    })
    const change = await call(
      running,
      '/model/settings',
      { baseUrl: providerUrl, model: 'other' },
      running.humanToken,
    )
    expect(change.body).toMatchObject({ failure: { code: 'unauthorized' } })
    expect(settings.name).toBe('from-env')
  })

  it('is offered on a person’s own service, where saving and clearing still work', async () => {
    const file = join(directory, 'model.json')
    const { model, modelSettings } = await serviceModel({ file, shared: false })
    expect(modelSettings).toBe(model)
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model, modelSettings: modelSettings! }),
    })
    const person = service.humanToken!
    const saved = await call(
      service,
      '/model/settings',
      { baseUrl: providerUrl, model: 'mine', apiKey: KEY },
      person,
    )
    expect(saved.body['model']).toMatchObject({ name: 'mine', source: 'settings', hasKey: true })
    expect(await model.complete([{ role: 'user', content: 'q' }])).toMatchObject({ text: '好' })
    const cleared = await call(service, '/model/clear', {}, person)
    expect(cleared.body['model']).toMatchObject({ simulated: true, source: 'none' })
    await expect(stat(file)).rejects.toThrow()
  })

  it('refuses an address that is not http or https', async () => {
    const settings = await ModelSettings.open(join(directory, 'model.json'))
    const running = await serve(settings)
    const refused = await call(
      running,
      '/model/settings',
      { baseUrl: 'file:///etc/passwd', model: 'm' },
      running.humanToken,
    )
    expect(refused.status).toBe(422)
    expect(seen).toEqual([])
  })
})

/**
 * A shared service has one model for everyone. If one signed-in person could choose it, every other person's
 * questions, materials and conversations would go to an address that person picked, and they could also wipe the
 * configured model. So on a shared service the model comes only from whoever runs it, and no request changes it.
 */
describe('model settings on a shared service', () => {
  let service: EpistemeService
  let model: ModelSettings
  let file: string
  let lin: string
  let wei: string
  let weiAgent: string
  let elsewhere: Server
  let elsewhereUrl: string
  let reachedElsewhere: number
  const DEPLOYED = { model: 'deployed', apiKey: KEY }

  beforeEach(async () => {
    // A provider someone would like everyone's questions to go to. It answers anything, so only refusal stops it.
    reachedElsewhere = 0
    elsewhere = createServer((request, response) => {
      reachedElsewhere += 1
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: '好' } }],
        }),
      )
    })
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve))
    elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/v1`

    const users = join(directory, 'users.json')
    const linId = await addPerson(users, '林')
    const weiId = await addPerson(users, '魏')
    lin = await addToken(users, linId, 'human', 'workbench')
    wei = await addToken(users, weiId, 'human', 'workbench')
    weiAgent = await addToken(users, weiId, 'agent', 'claude-code')

    // What the person running the service put beside the graph before starting it.
    file = join(directory, 'model.json')
    await writeFile(file, JSON.stringify({ baseUrl: providerUrl, ...DEPLOYED }))
    // Wired the way serve.ts wires it, so the test follows whatever serviceModel offers.
    const chosen = await serviceModel({ file, shared: true })
    model = chosen.model as ModelSettings
    service = await startService({
      port: 0,
      graph: join(directory, 'shared.db'),
      profile: workbenchProfile(chosen),
      mode: 'shared',
      users,
      publicOrigin: 'https://workbench.example.edu',
    })
  })

  afterEach(async () => {
    await service.close()
    await new Promise<void>((resolve) => elsewhere.close(() => resolve()))
  })

  async function call(
    path: string,
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${service.url}/api/v1/scene/workbench${path}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  /** The page settings are not offered on this service at all, whoever asks. */
  function notOffered(reply: { status: number; body: Record<string, unknown> }): void {
    expect(reply.status).toBe(422)
    expect(reply.body['code']).toBe('not_found')
    expect(JSON.stringify(reply.body)).not.toContain(KEY)
  }

  /** What a person reads of the model: its name, never where it is or whether it has a key. */
  function onlyName(reply: { status: number; body: Record<string, unknown> }, name: string): void {
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ name, simulated: false })
    for (const hidden of ['baseUrl', 'apiKey', 'hasKey', 'source', 'model', 'reasoningEffort']) {
      expect(reply.body).not.toHaveProperty(hidden)
    }
    expect(JSON.stringify(reply.body)).not.toContain(KEY)
    expect(JSON.stringify(reply.body)).not.toContain(providerUrl)
  }

  /** Nothing about the configured model moved, and nothing reached the other provider. */
  async function unchanged(): Promise<void> {
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ baseUrl: providerUrl, ...DEPLOYED })
    expect(model.view()).toMatchObject({
      name: 'deployed',
      source: 'settings',
      baseUrl: providerUrl,
    })
    expect(reachedElsewhere).toBe(0)
    seen = []
    expect(await model.complete([{ role: 'user', content: 'q' }])).toMatchObject({ text: '好' })
    expect(seen).toEqual([{ model: 'deployed', auth: `Bearer ${KEY}` }])
  }

  it('answers with the model whoever runs it configured, and shows people only its name', async () => {
    onlyName(await call('/model', undefined, lin), 'deployed')
    onlyName(await call('/model', undefined, wei), 'deployed')
    onlyName(await call('/model', undefined, weiAgent), 'deployed')
    await unchanged()
  })

  it('lets no signed-in person point everyone’s model elsewhere or clear it', async () => {
    notOffered(
      await call(
        '/model/settings',
        { baseUrl: elsewhereUrl, model: 'theirs', apiKey: 'sk-theirs' },
        wei,
      ),
    )
    // Changing only the name at the same address would reuse the saved key: refused just the same.
    notOffered(await call('/model/settings', { baseUrl: providerUrl, model: 'x' }, wei))
    notOffered(await call('/model/clear', {}, wei))
    notOffered(await call('/model/clear', {}, lin))
    onlyName(await call('/model', undefined, lin), 'deployed')
    await unchanged()
  })

  it('lets no agent change or clear it either', async () => {
    const redirect = await call(
      '/model/settings',
      { baseUrl: elsewhereUrl, model: 'theirs' },
      weiAgent,
    )
    expect(redirect.status).toBe(403)
    expect((await call('/model/clear', {}, weiAgent)).status).toBe(403)
    await unchanged()
  })

  it('cannot be reached around: no credential, a made-up one, or a body claiming another mode', async () => {
    const attempt = { baseUrl: elsewhereUrl, model: 'theirs', apiKey: 'sk-theirs' }
    expect((await call('/model/settings', attempt)).status).toBe(401)
    expect((await call('/model/clear', {})).status).toBe(401)
    expect((await call('/model/settings', attempt, 'ep_made_up')).status).toBe(401)
    expect((await call('/model/clear', {}, 'ep_made_up')).status).toBe(401)
    const claims = {
      ...attempt,
      mode: 'local',
      shared: false,
      actorId: 'owner',
      source: 'settings',
      role: 'admin',
    }
    notOffered(await call('/model/settings', claims, wei, { 'x-episteme-actor': 'owner' }))
    notOffered(await call('/model/clear', { mode: 'local' }, wei))
    await unchanged()
  })

  it('keeps a model from the environment, which no one can change either', async () => {
    await service.close()
    const environment = remoteModel({ baseUrl: providerUrl, model: 'from-env', apiKey: KEY })
    const chosen = await serviceModel({ file, fromEnvironment: environment, shared: true })
    service = await startService({
      port: 0,
      graph: join(directory, 'shared.db'),
      profile: workbenchProfile(chosen),
      mode: 'shared',
      users: join(directory, 'users.json'),
      publicOrigin: 'https://workbench.example.edu',
    })
    onlyName(await call('/model', undefined, lin), 'from-env')
    notOffered(await call('/model/settings', { baseUrl: elsewhereUrl, model: 'theirs' }, wei))
    notOffered(await call('/model/clear', {}, wei))
    expect(chosen.model.name).toBe('from-env')
    expect(reachedElsewhere).toBe(0)
  })
})
