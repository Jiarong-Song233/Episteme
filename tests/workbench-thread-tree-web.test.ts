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
 * Branching a conversation by hand: from any turn it shows, into a tree on the shelf, through a refresh and a restart,
 * and on a phone.
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
  throw new Error('CI needs Edge or Chrome for the branching journey')
}

const HOOK_TIMEOUT = 60_000
const NOTES =
  '# 位置编码\n\n位置编码把序列的顺序告诉模型。\n\n# 注意力\n\n注意力机制让词元彼此关联。\n'
const THREAD = /#\/spaces\/[^/]+\/threads\/([^/?]+)$/

describe.skipIf(browser === undefined)('branching a conversation in a browser', () => {
  let built: string
  let directory: string
  let service: EpistemeService
  let page: Page
  const errors: string[] = []

  const main = (): ReturnType<Page['getByRole']> => page.getByRole('main')
  const shelf = (): ReturnType<Page['locator']> => page.locator('.shelf')
  const threadOf = (url: string): string => THREAD.exec(url)?.[1] ?? ''

  const newSpace = async (name: string): Promise<void> => {
    await page.getByLabel('新空间的名字').fill(name)
    await page.getByRole('button', { name: '新建' }).click()
    await page.getByRole('heading', { name }).waitFor()
  }

  const upload = async (name: string): Promise<void> => {
    await page.getByRole('button', { name: /^材料（/ }).click()
    await page.locator('.upload input').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(NOTES),
    })
    await page.locator('.material-list').getByRole('button', { name, exact: true }).waitFor()
    await page.getByRole('button', { name: '学习', exact: true }).click()
  }

  /** Asks and waits for the answer to land under the question. */
  const ask = async (question: string): Promise<void> => {
    const answers = await page.locator('.answer-block').count()
    await page.getByLabel('你的问题').fill(question)
    await page.getByRole('button', { name: '提问' }).click()
    await page.waitForURL(THREAD)
    await expect.poll(() => page.locator('.answer-block').count()).toBe(answers + 1)
  }

  /** Branches from the turn whose words begin as given, and waits for the branch to open. */
  const forkFrom = async (words: string, nth = 0): Promise<string> => {
    const before = page.url()
    await main()
      .getByRole('button', { name: `从这里分叉：${words}` })
      .nth(nth)
      .click()
    await expect.poll(() => page.url()).not.toBe(before)
    await page.waitForURL(THREAD)
    await main().getByRole('separator').waitFor()
    return threadOf(page.url())
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

  const start = async (): Promise<void> => {
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel() }),
      workspace: built,
    })
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-thread-tree-'))
    errors.length = 0
    await start()
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

  it('branches from an answer, goes on there, and leaves the original as it was', async () => {
    await newSpace('机器学习')
    await upload('编码笔记.md')
    await ask('位置编码有什么用')
    await ask('注意力是什么')
    const original = threadOf(page.url())
    // A conversation that never branched carries nothing over.
    expect(await main().getByRole('separator').count()).toBe(0)

    // The first answer: the branch carries the first question and its answer, not what followed.
    const branch = await forkFrom('', 1)
    expect(branch).not.toBe(original)
    await main().getByText('以上继承自《位置编码有什么用》，以下是这个分支自己的对话').waitFor()
    await main().getByText('这是《位置编码有什么用》的一个分支，原对话不受影响。').waitFor()
    expect(await main().locator('.carried .learner-turn').count()).toBe(1)
    expect(await main().locator('.carried .answer-block').count()).toBe(1)
    expect(await main().innerText()).not.toContain('注意力是什么')

    // The shelf holds it under the line it left, and it is the one on show.
    const current = shelf().getByRole('button', { name: '位置编码有什么用 · 分支 1' })
    expect(await current.getAttribute('aria-current')).toBe('true')
    await shelf().getByRole('button', { name: '收起《位置编码有什么用》的分支' }).waitFor()
    expect(await shelf().locator('.thread-branches').getByRole('button').allInnerTexts()).toEqual([
      '位置编码有什么用 · 分支 1',
    ])

    // Going on here stays on the branch.
    await ask('顺序为什么重要')
    expect(threadOf(page.url())).toBe(branch)
    expect(await main().locator('.carried').innerText()).not.toContain('顺序为什么重要')

    // The original still ends where it did.
    await shelf().getByRole('button', { name: '位置编码有什么用', exact: true }).click()
    await page.waitForURL(new RegExp(`/threads/${original}$`))
    await main().getByText('注意力是什么').first().waitFor()
    expect(await main().innerText()).not.toContain('顺序为什么重要')
    expect(await main().getByRole('separator').count()).toBe(0)
    expect(await current.getAttribute('aria-current')).toBe('false')
  }, 120_000)

  it('branches a branch from its own turns or the ones it carries, through a refresh and a restart', async () => {
    await newSpace('机器学习')
    await upload('编码笔记.md')
    await ask('位置编码有什么用')
    const root = threadOf(page.url())
    const first = await forkFrom('位置编码有什么用')
    await ask('顺序为什么重要')

    // From a turn said on the branch: the new one carries both lines, the root's and the branch's.
    const deep = await forkFrom('顺序为什么重要')
    expect(deep).not.toBe(first)
    const carried = await main().locator('.carried').innerText()
    expect(carried).toContain('位置编码有什么用')
    expect(carried).toContain('顺序为什么重要')
    await main()
      .getByText('以上继承自《位置编码有什么用 · 分支 1》，以下是这个分支自己的对话')
      .waitFor()
    // Two levels down on the shelf.
    await shelf()
      .locator('.thread-branches .thread-branches')
      .getByRole('button', { name: '位置编码有什么用 · 分支 1 · 分支 1' })
      .waitFor()

    // From a turn the branch only carries over: that works too.
    const back = await forkFrom('位置编码有什么用')
    expect(await main().locator('.carried').innerText()).not.toContain('顺序为什么重要')
    await page.goBack()
    await page.waitForURL(new RegExp(`/threads/${deep}$`))

    // Folding a line hides its branches and says how many; the line itself stays.
    await shelf().getByRole('button', { name: '收起《位置编码有什么用》的分支' }).click()
    await shelf().getByText('3 个分支').waitFor()
    expect(await shelf().locator('.thread-branches').count()).toBe(0)
    await shelf().getByRole('button', { name: '展开《位置编码有什么用》的分支' }).click()
    await shelf().locator('.thread-branches').first().waitFor()

    // The way back to where the branch left its line, with that turn marked.
    await main().getByRole('button', { name: '回到分叉处' }).click()
    await page.waitForURL(new RegExp(`\\?turn=turn_[^#]+#/spaces/[^/]+/threads/${first}$`))
    await page.locator('[data-focused="true"]').getByText('顺序为什么重要').waitFor()

    // A refresh and a restart keep the tree and what each branch carries.
    await page.reload()
    await main().getByText('以上继承自《位置编码有什么用》，以下是这个分支自己的对话').waitFor()
    const address = new URL(page.url())
    await service.close()
    await start()
    await page.goto(`${service.workspaceUrl ?? ''}${address.hash}`)
    await main().getByText('以上继承自《位置编码有什么用》，以下是这个分支自己的对话').waitFor()
    const titles = await shelf().locator('.thread-tree .row').allInnerTexts()
    expect(titles).toEqual([
      '位置编码有什么用',
      '位置编码有什么用 · 分支 1',
      '位置编码有什么用 · 分支 1 · 分支 1',
      // Branched from the deep one, at a turn it carries.
      '位置编码有什么用 · 分支 1 · 分支 1 · 分支 1',
    ])
    expect([root, first, deep, back].every((id) => id.startsWith('thr_'))).toBe(true)
  }, 120_000)

  it('offers no branching in an archived space, and none in another space', async () => {
    await newSpace('机器学习')
    await upload('编码笔记.md')
    await ask('位置编码有什么用')
    const link = page.url()
    expect(
      await main()
        .getByRole('button', { name: /^从这里分叉/ })
        .count(),
    ).toBe(2)

    await newSpace('线性代数')
    await page.waitForURL(/\/new/)
    // The other space's shelf has nothing of the first one's.
    expect(await shelf().getByRole('button', { name: '位置编码有什么用' }).count()).toBe(0)

    await page.getByRole('button', { name: '机器学习', exact: true }).click()
    await page.getByRole('button', { name: '归档这个空间' }).click()
    await page.getByText('已归档（1）').waitFor()
    // Archiving moves on to the other space, which, being empty, settles on its new-conversation address.
    await page.waitForURL(/\/new$/)
    await page.goto(link)
    await main().getByText('位置编码有什么用').first().waitFor()
    expect(
      await main()
        .getByRole('button', { name: /^从这里分叉/ })
        .count(),
    ).toBe(0)
  }, 120_000)

  it('branches and switches branches at phone width without the page running sideways', async () => {
    await newSpace('机器学习')
    await upload('编码笔记.md')
    await ask('位置编码有什么用')
    const original = threadOf(page.url())
    await page.setViewportSize({ width: 390, height: 844 })
    await forkFrom('位置编码有什么用')
    await ask('顺序为什么重要')
    const sideways = (): Promise<boolean> =>
      page.evaluate<boolean>(
        'document.documentElement.scrollWidth > document.documentElement.clientWidth',
      )
    expect(await sideways()).toBe(false)

    await page.getByRole('button', { name: '空间', exact: true }).click()
    await shelf().getByRole('button', { name: '收起《位置编码有什么用》的分支' }).waitFor()
    expect(await sideways()).toBe(false)
    await shelf().getByRole('button', { name: '位置编码有什么用', exact: true }).click()
    await page.waitForURL(new RegExp(`/threads/${original}$`))
    await main().getByText('位置编码有什么用').first().waitFor()
    expect(await main().getByRole('separator').count()).toBe(0)
  }, 120_000)
})
