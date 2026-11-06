import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startService, type EpistemeService } from '@episteme/service'
import { ModelSettings, remoteModel, workbenchProfile } from '@episteme/workbench'
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
