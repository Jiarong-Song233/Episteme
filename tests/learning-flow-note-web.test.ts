import { exec } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type EpistemeService, startService } from '@episteme/service'
import { type ModelClient, type ModelMessage, workbenchProfile } from '@episteme/workbench'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/** The learning-flow page shows, under a step, why a doubt brought its focus back, and keeps it across a reload. */

const SCENE = '/scene/workbench'
const NOTES = `# Transformer 笔记

## 位置编码

位置编码把序列的顺序告诉模型。没有它，注意力机制看不出词的先后。
`
const LIKE_FOCUS = '位置编码把词的顺序告诉模型'
const NOTE = `你对“${LIKE_FOCUS}”记下了怀疑，所以这次不跳过。`

const model: ModelClient = {
  name: 'scripted',
  simulated: false,
  complete(messages: readonly ModelMessage[]) {
    const system = messages[0]?.content ?? ''
    if (system.includes('学习重点')) return Promise.resolve({ text: '{"focuses":["位置编码"]}' })
    return Promise.resolve({ text: '位置编码把序列的顺序告诉模型[1]。' })
  },
}

async function installedBrowser(): Promise<Browser | undefined> {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel })
    } catch {
      continue
    }
  }
  return undefined
}

const browser = await installedBrowser()
if (browser === undefined)
  throw new Error('An installed Edge or Chrome is required for the UI journey')
const installed = browser

async function rest<T>(service: EpistemeService, path: string, body?: unknown): Promise<T> {
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
  return payload
}

describe('the learning-flow page and a doubt note', () => {
  let built: string
  let directory: string
  let service: EpistemeService
  let page: Page
  const errors: string[] = []

  beforeAll(async () => {
    built = await mkdtemp(join(tmpdir(), 'episteme-flow-note-web-'))
    await promisify(exec)(
      `pnpm --filter @episteme/workbench-web exec vite build --outDir "${built}" --emptyOutDir`,
    )
  }, 180_000)

  afterAll(async () => {
    await installed.close()
    await rm(built, { recursive: true, force: true, maxRetries: 5 })
  })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-flow-note-graph-'))
    errors.length = 0
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model }),
      workspace: built,
    })
    const context = await installed.newContext({ viewport: { width: 1280, height: 900 } })
    page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
  }, 60_000)

  afterEach(async () => {
    await page.context().close()
    await service.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
    expect(errors).toEqual([])
  }, 60_000)

  it('shows the doubt note under its step, and keeps it after a reload', async () => {
    const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
    const ok = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = await host.call(name, args)
      if (result.isError === true) throw new Error(`${name}: ${JSON.stringify(result)}`)
      return result.structuredContent as T
    }
    const { space } = await ok<{ space: { id: string; scope: string } }>('learn_space_open', {
      submission: 'sub-1',
      name: '机器学习',
    })
    await rest(service, `${SCENE}/materials`, {
      space: space.id,
      fileName: '笔记.md',
      contentBase64: Buffer.from(NOTES).toString('base64'),
    })
    const { suggestion } = await ok<{ suggestion: { id: string } }>('propose', {
      kind: 'claim',
      label: LIKE_FOCUS,
      rationale: '本人这样说',
      scope: space.scope,
    })
    await rest(service, '/suggestions/decide', { id: suggestion.id, action: 'accept' })
    const { nodes } = await rest<{ nodes: readonly { nodeId: string; label: string }[] }>(
      service,
      `${SCENE}/understanding?space=${space.id}`,
    )
    const node = nodes.find((each) => each.label === LIKE_FOCUS)?.nodeId ?? ''
    // The person records a conflict level on what they hold, the way accepting a doubt does.
    const doubt = await ok<{ suggestion: { id: string } }>('propose', {
      kind: 'state',
      target: node,
      dimension: 'conflict',
      level: 'suspected',
      rationale: '练习里没答对',
      scope: space.scope,
    })
    await rest(service, '/suggestions/decide', { id: doubt.suggestion.id, action: 'accept' })
    // A plan made after the doubt puts the focus back, with the note that says why.
    const { plan } = await rest<{
      plan: { id: string; steps: readonly { block: string; note?: string }[] }
    }>(service, `${SCENE}/plans`, {
      space: space.id,
      topic: '位置编码',
      minutes: 15,
      workflow: 'speedrun',
    })
    expect(plan.steps.some((step) => step.note === NOTE)).toBe(true)

    await page.goto(`${service.workspaceUrl ?? ''}#/learning-flow/${space.id}`)
    await page.getByRole('heading', { name: '步骤进度' }).waitFor()
    await page.getByText(NOTE, { exact: false }).first().waitFor()
    await page.reload()
    await page.getByRole('heading', { name: '步骤进度' }).waitFor()
    await page.getByText(NOTE, { exact: false }).first().waitFor()
  }, 180_000)
})
