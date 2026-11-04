import { exec } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { startService, type EpistemeService } from '@episteme/service'
import {
  ModelFailure,
  SimulatedModel,
  workbenchProfile,
  type ModelClient,
} from '@episteme/workbench'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * The whole first experience, in a real browser, through the page a person uses.
 *
 * It drives an installed Edge or Chrome, so there is no browser download. Without one it skips locally; in CI it
 * fails, because a missing browser must not read as a passing journey.
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
  throw new Error('CI needs Edge or Chrome for the workbench journey')
}

const web = resolve(import.meta.dirname, '../apps/workbench/web')

// A browser context can take longer than the default ten seconds while other test files are building.
const HOOK_TIMEOUT = 60_000

const NOTES = `# 位置编码

位置编码把序列的顺序告诉模型。

# 注意力

注意力机制让词元彼此关联。
`

describe.skipIf(browser === undefined)('the workbench in a browser', () => {
  let directory: string
  let graph: string
  let service: EpistemeService | undefined
  let page: Page
  const errors: string[] = []

  const open = async (model: ModelClient = new SimulatedModel()): Promise<void> => {
    service = await startService({
      graph,
      port: 0,
      profile: workbenchProfile({ model }),
      workspace: join(web, 'dist'),
    })
    await page.goto(service.workspaceUrl ?? '')
  }

  const close = async (): Promise<void> => {
    await service?.close()
    service = undefined
  }

  const newSpace = async (name: string): Promise<void> => {
    await page.getByLabel('新空间的名字').fill(name)
    await page.getByRole('button', { name: '新建' }).click()
    await page.getByRole('heading', { name }).waitFor()
  }

  const upload = async (name: string, content: string): Promise<void> => {
    await page.locator('.upload input').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(content),
    })
  }

  const ask = async (question: string): Promise<void> => {
    await page.getByLabel('你的问题').fill(question)
    await page.getByRole('button', { name: '提问' }).click()
  }

  beforeAll(async () => {
    await promisify(exec)('pnpm --filter @episteme/workbench-web build')
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
  })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-web-'))
    graph = join(directory, 'graph.db')
    errors.length = 0
    page = await (await browser!.newContext()).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
  }, HOOK_TIMEOUT)

  afterEach(async () => {
    await page.context().close()
    await close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
    expect(errors).toEqual([])
  }, HOOK_TIMEOUT)

  it('takes a new person from nothing to saved understanding, and back after a restart', async () => {
    await open()
    await page.getByText('现在用的是模拟模型').waitFor()
    await newSpace('机器学习')
    await upload('编码笔记.md', NOTES)
    await page.getByRole('button', { name: '编码笔记.md', exact: true }).waitFor()

    await ask('位置编码有什么用')
    const cite = page.getByRole('button', { name: /查看引用 1：编码笔记\.md/ })
    await cite.waitFor()

    // The citation opens the source at the very passage.
    await cite.click()
    await expect.poll(() => page.locator('mark').textContent()).toContain('位置编码把序列的顺序')
    expect(await page.locator('mark').textContent()).not.toContain('注意力机制')

    // Nothing is understanding until the person says so.
    await page.getByRole('tab', { name: '我的理解（0）' }).waitFor()
    await page.getByRole('button', { name: '提炼成待确认的理解' }).click()
    await page.getByRole('tab', { name: '待确认（1）', selected: true }).waitFor()
    await page.getByRole('tab', { name: '我的理解（0）' }).waitFor()

    await page.getByRole('button', { name: '确认为我的理解' }).click()
    await page.getByRole('tab', { name: '我的理解（1）' }).click()
    await page.locator('.understood li', { hasText: '位置编码' }).waitFor()

    await close()
    await open()

    await page.getByRole('heading', { name: '机器学习' }).waitFor()
    await page.getByRole('button', { name: '编码笔记.md', exact: true }).waitFor()
    await page.getByRole('button', { name: '位置编码有什么用' }).waitFor()
    await page.locator('.question', { hasText: '位置编码有什么用' }).waitFor()
    await page.getByRole('button', { name: /查看引用 1/ }).waitFor()
    await page.getByRole('tab', { name: '我的理解（1）' }).click()
    await page.locator('.understood li', { hasText: '位置编码' }).waitFor()
  }, 60_000)

  it('marks what the material does not support, and what it cannot answer', async () => {
    const model: ModelClient = {
      name: 'stub',
      simulated: false,
      complete: () =>
        Promise.resolve({
          text: '位置编码把序列的顺序告诉模型。[1]\n我猜这也影响训练速度。[推断]',
        }),
    }
    await open(model)
    await expect.poll(() => page.getByText('现在用的是模拟模型').count()).toBe(0)
    await newSpace('机器学习')
    await upload('a.md', NOTES)
    await page.getByRole('button', { name: 'a.md', exact: true }).waitFor()

    await ask('位置编码有什么用')
    await page.locator('.inferred', { hasText: '我猜这也影响训练速度' }).waitFor()
    await page.locator('.sourced', { hasText: '位置编码把序列' }).waitFor()

    await ask('光合作用的暗反应在哪里发生')
    await page.getByText('材料里没有足够的依据').waitFor()
  }, 60_000)

  it('says why a file is refused, keeps a failed question, and answers it on retry', async () => {
    let fail = true
    const model: ModelClient = {
      name: 'stub',
      simulated: false,
      complete: () =>
        fail
          ? Promise.reject(new ModelFailure('timeout', '模型超时没有回应。'))
          : Promise.resolve({ text: '位置编码把序列的顺序告诉模型。[1]' }),
    }
    await open(model)
    await newSpace('机器学习')
    await upload('a.docx', 'x')
    await page.getByRole('alert').getByText('.txt').waitFor()

    await upload('a.md', NOTES)
    await page.getByRole('button', { name: 'a.md', exact: true }).waitFor()
    await ask('位置编码有什么用')
    await page.getByText('模型超时没有回应').waitFor()
    await page.locator('.question').waitFor()

    fail = false
    await page.getByRole('button', { name: '重试' }).click()
    await page.getByRole('button', { name: /查看引用 1/ }).waitFor()
    await expect.poll(() => page.locator('.question').count()).toBe(1)
  }, 60_000)

  it('deletes material, and keeps what an old answer quoted from it', async () => {
    await open()
    await newSpace('机器学习')
    await upload('a.md', NOTES)
    await page.getByRole('button', { name: 'a.md', exact: true }).waitFor()
    await ask('位置编码有什么用')
    const cite = page.getByRole('button', { name: /查看引用 1/ })
    await cite.waitFor()

    const remove = page.getByRole('button', { name: '删除 a.md' })
    await remove.click()
    await remove.click()
    await expect.poll(() => page.getByRole('button', { name: 'a.md', exact: true }).count()).toBe(0)

    await cite.click()
    await page.getByText('这份材料已被删除').waitFor()
    await page.locator('.kept-quote', { hasText: '位置编码' }).waitFor()
  }, 60_000)

  it('fits a phone', async () => {
    await open()
    await page.setViewportSize({ width: 375, height: 812 })
    await newSpace('机器学习')
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: '原文与理解' }).click()
    await page.getByRole('tab', { name: '原文', exact: true }).waitFor()
  }, 60_000)
})
