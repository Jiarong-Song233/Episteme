import { exec } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startService, type EpistemeService } from '@episteme/service'
import { SimulatedModel, workbenchProfile } from '@episteme/workbench'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * Filing a candidate made outside any space, in a browser: the space it lands in shows it without a reload.
 *
 * Like the other journeys, it drives an installed Edge or Chrome: skipped locally without one, a failure in CI.
 */

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
if (browser === undefined && process.env['CI'] !== undefined) {
  throw new Error('CI needs Edge or Chrome for the unfiled journey')
}

const HOOK_TIMEOUT = 60_000
const LABEL = '条件概率的分母是已知条件下的总体'

describe.skipIf(browser === undefined)('unfiled candidates in a browser', () => {
  let built: string
  let directory: string
  let service: EpistemeService
  let page: Page
  const errors: string[] = []

  const main = (): ReturnType<Page['getByRole']> => page.getByRole('main')
  /** Moves to another address in the same page, without loading it again. */
  const moveTo = async (hash: string): Promise<void> => {
    await page.goto(`${page.url().replace(/#.*$/, '')}${hash}`)
  }

  beforeAll(async () => {
    built = await mkdtemp(join(tmpdir(), 'episteme-web-build-'))
    await promisify(exec)(
      `pnpm --filter @episteme/workbench-web exec vite build --outDir "${built}" --emptyOutDir`,
    )
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await rm(built, { recursive: true, force: true, maxRetries: 5 })
  })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-unfiled-web-'))
    errors.length = 0
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel() }),
      workspace: built,
    })
    page = await (await browser!.newContext()).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(service.workspaceUrl ?? '')
  }, HOOK_TIMEOUT)

  afterEach(async () => {
    await page.context().close()
    await service.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
    expect(errors).toEqual([])
  }, HOOK_TIMEOUT)

  it('shows a candidate filed into the open space on that space at once', async () => {
    await main().getByLabel('第一个空间的名字').fill('概率')
    await main().getByRole('button', { name: '建好并进入' }).click()
    await page.waitForURL(/#\/spaces\/sp_/)
    const space = /#\/spaces\/(sp_[^/]+)/.exec(page.url())?.[1] ?? ''
    expect(space).not.toBe('')
    await page.getByRole('heading', { name: '概率' }).waitFor()

    // The space's understanding is in hand, still empty, before the candidate is filed.
    await moveTo(`#/spaces/${space}/understanding`)
    await main().getByText('这里只放你亲自确认过的内容。还没有。').waitFor()

    const wire = mcpWire(() => service.mcpUrl, { name: 'Notes Agent', version: '1' })
    const proposed = await wire.call('propose', {
      kind: 'claim',
      label: LABEL,
      rationale: '学生在对话里这样说',
    })
    expect(proposed.isError).not.toBe(true)

    await moveTo('#/unfiled')
    await main().getByText(LABEL).waitFor()
    await main().getByRole('combobox').selectOption({ label: '概率' })
    await main().getByRole('button', { name: '确认并归入这个空间' }).click()
    await main().getByText('没有未分类的待确认内容。').waitFor()

    // Back to the same space without a reload: what was just filed is there.
    await moveTo(`#/spaces/${space}/understanding`)
    await main().getByText(LABEL).waitFor()
  }, 60_000)
})
