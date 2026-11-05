import { exec } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startService, type EpistemeService } from '@episteme/service'
import { SimulatedModel, workbenchProfile } from '@episteme/workbench'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Every place on the page has an address: a refresh, the back button and a pasted link land where the person was.
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
  throw new Error('CI needs Edge or Chrome for the address journey')
}

const HOOK_TIMEOUT = 60_000
const NOTES =
  '# 位置编码\n\n位置编码把序列的顺序告诉模型。\n\n# 注意力\n\n注意力机制让词元彼此关联。\n'

describe.skipIf(browser === undefined)('addresses in a browser', () => {
  let built: string
  let directory: string
  let service: EpistemeService
  let page: Page
  const errors: string[] = []

  const newSpace = async (name: string): Promise<void> => {
    await page.getByLabel('新空间的名字').fill(name)
    await page.getByRole('button', { name: '新建' }).click()
    await page.getByRole('heading', { name }).waitFor()
  }

  const upload = async (name: string): Promise<void> => {
    await page.locator('.upload input').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(NOTES),
    })
    await page.getByRole('button', { name, exact: true }).waitFor()
  }

  const ask = async (question: string): Promise<void> => {
    await page.getByLabel('你的问题').fill(question)
    await page.getByRole('button', { name: '提问' }).click()
    await page.getByRole('main').getByText(question).first().waitFor()
    await page.waitForURL(/#\/spaces\/[^/]+\/threads\//)
    await page
      .getByRole('button', { name: /查看引用 1/ })
      .first()
      .waitFor()
  }

  const main = (): ReturnType<Page['getByRole']> => page.getByRole('main')

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
    directory = await mkdtemp(join(tmpdir(), 'episteme-routes-'))
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

  it('keeps a conversation through a refresh, and goes back and forward', async () => {
    await newSpace('机器学习')
    await upload('编码笔记.md')
    await ask('位置编码有什么用')
    const first = page.url()

    await page.getByRole('button', { name: '开始新对话' }).click()
    await page.waitForURL(/\/new/)
    await ask('注意力是什么')
    const second = page.url()
    expect(second).not.toBe(first)

    // Going to the older conversation by hand, so a refresh cannot just be opening the latest one.
    await page.getByRole('button', { name: '位置编码有什么用', exact: true }).click()
    await page.waitForURL(first)
    await main().getByText('位置编码有什么用').first().waitFor()
    await page.reload()
    await main().getByText('位置编码有什么用').first().waitFor()
    expect(page.url()).toBe(first)
    expect(await main().innerText()).not.toContain('注意力是什么')

    await page.goBack()
    await page.waitForURL(second)
    await main().getByText('注意力是什么').first().waitFor()
    await page.goForward()
    await page.waitForURL(first)
    await main().getByText('位置编码有什么用').first().waitFor()
  }, 120_000)

  it('opens a pasted link in another space, not the last one used', async () => {
    await newSpace('机器学习')
    await upload('编码笔记.md')
    await ask('位置编码有什么用')
    const link = page.url()

    await newSpace('线性代数')
    await page.waitForURL(/\/new/)

    const other = await page.context().newPage()
    await other.goto(link)
    await other.getByRole('heading', { name: '机器学习' }).waitFor()
    await other.getByRole('main').getByText('位置编码有什么用').first().waitFor()
    await other.close()

    // Going back across spaces reads the other space again.
    await page.goBack()
    await page.getByRole('heading', { name: '机器学习' }).waitFor()
    await main().getByText('位置编码有什么用').first().waitFor()
  }, 120_000)

  it('keeps the side column and the cited passage through a refresh', async () => {
    await newSpace('机器学习')
    await upload('编码笔记.md')
    await ask('位置编码有什么用')

    await page.getByRole('button', { name: /查看引用 1：编码笔记\.md/ }).click()
    await expect.poll(() => page.locator('mark').textContent()).toContain('位置编码把序列的顺序')
    expect(page.url()).toContain('material=')
    // The words of a citation stay out of the address.
    expect(decodeURIComponent(page.url())).not.toContain('位置编码')

    await page.reload()
    await expect.poll(() => page.locator('mark').textContent()).toContain('位置编码把序列的顺序')

    await page.getByRole('tab', { name: /待确认/ }).click()
    await page.waitForURL(/side=pending/)
    await page.reload()
    await expect
      .poll(() => page.getByRole('tab', { name: /待确认/ }).getAttribute('aria-selected'))
      .toBe('true')

    await page.goBack()
    await expect.poll(() => page.locator('mark').textContent()).toContain('位置编码把序列的顺序')
  }, 120_000)

  it('starts at the first space and does not trap the back button', async () => {
    await newSpace('机器学习')
    const fresh = await page.context().newPage()
    await fresh.goto('about:blank')
    await fresh.goto(`${service.workspaceUrl ?? ''}#/`)
    await fresh.waitForURL(/#\/spaces\/[^/]+\/new/)
    await fresh.getByRole('heading', { name: '机器学习' }).waitFor()

    // The address it settled on replaced the ones that led there, so going back leaves instead of bouncing.
    await fresh.goBack()
    await fresh.waitForURL('about:blank')
    await fresh.close()
  }, 60_000)

  it('says so when an address names a space that is not there', async () => {
    await newSpace('机器学习')
    // An empty space settles on its own address first, which would replace the one this test is about to write.
    await page.waitForURL(/\/new/)
    await page.goto(`${service.workspaceUrl ?? ''}#/spaces/space_gone/threads/thread_gone`)
    await page.reload()
    await page.getByText('找不到这个地址里的空间').waitFor()
    await page.getByRole('button', { name: '机器学习', exact: true }).click()
    await page.getByRole('heading', { name: '机器学习' }).waitFor()
    expect(await main().innerText()).not.toContain('找不到这个地址里的空间')
  }, 60_000)
})
