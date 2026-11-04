import { exec } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { SimulatedModel, workbenchProfile } from '@episteme/workbench'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Two people, two browsers, one service: one publishes, the other cites and answers, through the page alone.
 *
 * Like the first journey, it drives an installed Edge or Chrome: skipped locally without one, a failure in CI.
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
  throw new Error('CI needs Edge or Chrome for the sharing journey')
}

// A browser context can take longer than the default ten seconds while other test files are building.
const HOOK_TIMEOUT = 60_000

const NOTES = `# 位置编码

位置编码把序列的顺序告诉模型。
`

const WEIS_VERSION = '位置编码把序列的顺序告诉模型，正弦版本不需要训练。'

describe.skipIf(browser === undefined)('sharing in a browser', () => {
  let built: string
  let directory: string
  let service: EpistemeService
  let tokens: { lin: string; wei: string }
  const errors: string[] = []
  const pages: Page[] = []

  const enter = async (token: string): Promise<Page> => {
    const page = await (await browser!.newContext()).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    pages.push(page)
    await page.goto(service.workspaceUrl ?? '')
    await page.getByLabel('你的登录令牌').fill(token)
    await page.getByRole('button', { name: '登录' }).click()
    await page.getByLabel('新空间的名字').waitFor()
    return page
  }

  const newSpace = async (page: Page, name: string): Promise<void> => {
    await page.getByLabel('新空间的名字').fill(name)
    await page.getByRole('button', { name: '新建' }).click()
    await page.getByRole('heading', { name }).waitFor()
  }

  /** The ordinary way anything comes to be held: asked about, distilled, and confirmed by the person. */
  const holdFromNotes = async (page: Page): Promise<void> => {
    await page.locator('.upload input').setInputFiles({
      name: '编码笔记.md',
      mimeType: 'text/plain',
      buffer: Buffer.from(NOTES),
    })
    await page.getByRole('button', { name: '编码笔记.md', exact: true }).waitFor()
    await page.getByLabel('你的问题').fill('位置编码有什么用')
    await page.getByRole('button', { name: '提问' }).click()
    await page.getByRole('button', { name: '提炼成待确认的理解' }).click()
    await page.getByRole('button', { name: '确认为我的理解' }).click()
    await page.getByRole('tab', { name: '我的理解（1）' }).click()
    await page.locator('.understood li', { hasText: '位置编码' }).locator('button').first().click()
  }

  const publishOpened = async (page: Page): Promise<void> => {
    await page.getByRole('button', { name: '发布', exact: true }).click()
    await page.getByRole('button', { name: '看看会公开什么' }).click()
    await page.getByRole('heading', { name: '仍然只有你能看到' }).waitFor()
    await page.getByRole('button', { name: '确认发布' }).click()
    await page.locator('.publication h2').waitFor()
  }

  beforeAll(async () => {
    // Its own copy: another file's build empties a shared dist under a page that is still loading.
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
    directory = await mkdtemp(join(tmpdir(), 'episteme-sharing-web-'))
    errors.length = 0
    const users = join(directory, 'users.json')
    const person = async (name: string): Promise<string> =>
      addToken(users, await addPerson(users, name), 'human', 'workbench')
    tokens = { lin: await person('林'), wei: await person('魏') }
    service = await startService({
      port: 0,
      graph: join(directory, 'shared.db'),
      profile: workbenchProfile({ model: new SimulatedModel() }),
      workspace: built,
      mode: 'shared',
      users,
      publicOrigin: 'https://workbench.example.edu',
      sharing: true,
    })
  }, HOOK_TIMEOUT)

  afterEach(async () => {
    for (const page of pages.splice(0)) await page.context().close()
    await service.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
    expect(errors).toEqual([])
  }, HOOK_TIMEOUT)

  it('goes from one person publishing to another answering, and the original stays whole', async () => {
    const lin = await enter(tokens.lin)
    await lin.getByText('现在是 林').waitFor()
    await newSpace(lin, 'Transformer')
    await holdFromNotes(lin)

    // The preview says what leaves, and what does not, before anything does.
    await lin.getByRole('button', { name: '发布', exact: true }).click()
    await lin.getByRole('button', { name: '看看会公开什么' }).click()
    await lin.locator('.will-show').getByText('位置编码').first().waitFor()
    await lin.getByText(/全部对话原文/).waitFor()
    await lin.getByRole('button', { name: '返回修改' }).click()
    await lin.getByRole('button', { name: '取消' }).click()
    await publishOpened(lin)
    const original = await lin.locator('.publication h2').textContent()
    await lin.getByText(/你 发布于/).waitFor()

    const wei = await enter(tokens.wei)
    await newSpace(wei, '注意力')
    await wei.getByRole('button', { name: '公开成果' }).click()
    await wei.getByRole('heading', { name: '公开成果' }).waitFor()

    // Finding it by what it says, and by who wrote it.
    await wei.getByLabel('搜索公开成果').fill('没有这个词')
    await wei.getByRole('button', { name: '搜索' }).click()
    await wei.getByText('没有找到').waitFor()
    await wei.getByLabel('搜索公开成果').fill('位置编码')
    await wei.getByRole('button', { name: '搜索' }).click()
    await wei.locator('.publications').getByText('林').waitFor()
    await wei.locator('.publications .row').first().click()

    // Nothing for someone else's work is decided ahead of them: how sure they are is theirs to choose.
    await wei.locator('.publication').getByText('林 发布于').waitFor()
    await wei.getByRole('button', { name: '引用', exact: true }).click()
    expect(await wei.getByRole('button', { name: '引用到这个空间' }).isDisabled()).toBe(true)
    await wei.locator('.acting select').nth(1).selectOption({ index: 1 })
    await wei.getByRole('button', { name: '引用到这个空间' }).click()
    await wei.getByText('已引用到“注意力”').waitFor()

    // It now sits in their space, marked as someone else's, and they cannot reword it in place.
    await wei.getByRole('button', { name: '打开', exact: true }).click()
    await wei.getByText('林 发布的成果，不是你的原话').waitFor()
    await wei.getByRole('button', { name: '提出我的版本' }).click()
    const words = wei.locator('.node-detail textarea').first()
    await words.fill(WEIS_VERSION)
    await wei.getByLabel('为什么改（可不填）').fill('林没有说正弦版本')
    await wei.getByRole('button', { name: '保存我的版本' }).click()

    // Saving lands on their own version, theirs to publish.
    await wei.locator('.node-detail', { hasText: WEIS_VERSION }).waitFor()
    await publishOpened(wei)
    await wei.getByText('它回应的成果').waitFor()
    await wei.getByRole('main').getByRole('button', { name: '看谱系和差异' }).click()
    await wei.locator('.difference ins', { hasText: '正弦版本' }).waitFor()

    // The first author sees the answer with its author's name, and their own words unchanged.
    await lin.reload()
    await lin.getByRole('button', { name: '公开成果' }).click()
    await lin.locator('.publications .row', { hasText: original ?? '' }).click()
    await lin.locator('.responses', { hasText: '魏' }).getByText(WEIS_VERSION).waitFor()
    await lin.getByRole('main').getByRole('button', { name: '看谱系和差异' }).click()
    await lin.locator('.lineage').getByText('魏提出了自己的版本：林没有说正弦版本').waitFor()
    expect(await lin.locator('.publication h2').textContent()).toBe(original)

    // Withdrawing asks first, and takes the words away from others while the trace stays.
    await lin.getByRole('button', { name: '撤回这份成果' }).click()
    await lin.getByRole('button', { name: '确认撤回' }).click()
    await lin.getByText(/已撤回/).waitFor()
    await wei.reload()
    await wei.getByRole('button', { name: '公开成果' }).click()
    await expect
      .poll(() => wei.locator('.publications .row', { hasText: original ?? '' }).count())
      .toBe(0)
  }, 120_000)

  it('keeps a person signed out until a real token is given, and lets them change who they are', async () => {
    const page = await (await browser!.newContext()).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    pages.push(page)
    await page.goto(service.workspaceUrl ?? '')
    await page.getByLabel('你的登录令牌').fill('not-a-token')
    await page.getByRole('button', { name: '登录' }).click()
    await page.getByRole('alert').waitFor()
    await expect.poll(() => page.getByLabel('新空间的名字').count()).toBe(0)

    await page.getByLabel('你的登录令牌').fill(tokens.lin)
    await page.getByRole('button', { name: '登录' }).click()
    await page.getByText('现在是 林').waitFor()
    await newSpace(page, '林的空间')

    await page.getByRole('button', { name: '换一个身份' }).click()
    await page.getByLabel('你的登录令牌').fill(tokens.wei)
    await page.getByRole('button', { name: '登录' }).click()
    await page.getByText('现在是 魏').waitFor()
    // What the first person held went with them.
    await page.getByLabel('新空间的名字').waitFor()
    await expect.poll(() => page.getByText('林的空间').count()).toBe(0)
  }, 60_000)
})
