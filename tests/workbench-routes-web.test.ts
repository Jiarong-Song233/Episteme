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
    await page.getByRole('button', { name: /^材料（/ }).click()
    await page.locator('.upload input').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(NOTES),
    })
    await page.locator('.material-list').getByRole('button', { name, exact: true }).waitFor()
    await page.getByRole('button', { name: '学习', exact: true }).click()
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

  it('keeps the cited passage beside the page through a refresh, and beside review', async () => {
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

    // Review is a page of its own; the source stays open beside it.
    await page.getByRole('button', { name: /待确认（/ }).click()
    await page.waitForURL(/#\/spaces\/[^/]+\/review/)
    await page.reload()
    await main().getByRole('heading', { name: '待确认' }).waitFor()
    await expect.poll(() => page.locator('mark').textContent()).toContain('位置编码把序列的顺序')
    expect(await page.getByRole('button', { name: /待确认（/ }).getAttribute('aria-current')).toBe(
      'page',
    )

    await page.goBack()
    await main().getByText('位置编码有什么用').first().waitFor()
    await expect.poll(() => page.locator('mark').textContent()).toContain('位置编码把序列的顺序')

    // Closing the source gives the page its room back, and going back opens it again.
    await page.getByRole('button', { name: '关上原文' }).click()
    await expect.poll(() => page.locator('.side').isVisible()).toBe(false)
    expect(page.url()).not.toContain('material=')
    await page.goBack()
    await expect.poll(() => page.locator('mark').textContent()).toContain('位置编码把序列的顺序')
  }, 120_000)

  it('gives the materials a page of their own, with the source opening beside it', async () => {
    await newSpace('机器学习')
    // An empty conversation points to where material goes.
    await main().getByRole('button', { name: '去上传材料' }).click()
    await page.waitForURL(/#\/spaces\/[^/]+\/materials/)
    await main().getByText('这个空间还没有材料').waitFor()
    await page.locator('.upload input').setInputFiles({
      name: '编码笔记.md',
      mimeType: 'text/plain',
      buffer: Buffer.from(NOTES),
    })
    const title = main().getByRole('button', { name: '编码笔记.md', exact: true })
    await title.waitFor()
    await main()
      .getByText(/^Markdown，\d+ 字，\d+ 段，/)
      .waitFor()
    await page.getByRole('button', { name: '材料（1）' }).waitFor()

    await page.reload()
    await title.click()
    await page.locator('.side').getByText('位置编码把序列的顺序').first().waitFor()
    expect(page.url()).toMatch(/\?material=[^#]+#\/spaces\/[^/]+\/materials$/)
    expect(await page.getByRole('button', { name: '材料（1）' }).getAttribute('aria-current')).toBe(
      'page',
    )
    // The shelf keeps only the way to learning, not a second list of files.
    expect(await page.locator('.shelf').getByText('编码笔记.md').count()).toBe(0)
  }, 60_000)

  it('says how to connect an agent, with an address that answers MCP', async () => {
    await newSpace('机器学习')
    await page.locator('.shelf-foot').getByRole('button', { name: '接入 Agent' }).click()
    await page.waitForURL(/#\/connect$/)
    await main().getByRole('heading', { name: '接入 Agent' }).waitFor()

    const address = new URL('/mcp', service.workspaceUrl ?? '').href
    expect(await page.getByLabel('MCP 地址').innerText()).toBe(address)
    expect(await page.getByLabel('Claude Code 的接入方式').innerText()).toBe(
      `claude mcp add --transport http --scope user episteme ${address}`,
    )

    // What the page tells an agent to use is the service's own MCP endpoint, not a guess.
    const response = await fetch(address, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'routes-test', version: '0' },
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"serverInfo"')

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.getByRole('button', { name: '复制' }).first().click()
    await page.getByRole('button', { name: '已复制' }).waitFor()
    expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(address)

    // The page keeps its address, and the space stays in the sidebar beside it.
    await page.reload()
    await main().getByRole('heading', { name: '接入 Agent' }).waitFor()
    await page.getByRole('button', { name: '机器学习', exact: true }).waitFor()
  }, 60_000)

  it('installs as an app of its own, and the worker keeps the page but none of the data', async () => {
    await newSpace('机器学习')
    await upload('编码笔记.md')
    await ask('位置编码有什么用')

    // Run in the page as strings: these tests compile without the DOM's types.
    const manifest = await page.evaluate<{
      status: number
      body: { display: string; icons: { sizes: string; purpose?: string }[] }
      icons: number[]
    }>(`(async () => {
      const link = document.querySelector('link[rel="manifest"]')
      const answer = await fetch(link.href)
      const body = await answer.json()
      const icons = await Promise.all(
        body.icons.map(async (icon) => (await fetch(new URL(icon.src, answer.url))).status),
      )
      return { status: answer.status, body, icons }
    })()`)
    expect(manifest.status).toBe(200)
    expect(manifest.body.display).toBe('standalone')
    expect(manifest.body.icons.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    )
    expect(manifest.body.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
    expect(manifest.icons.every((status) => status === 200)).toBe(true)

    await page.evaluate('navigator.serviceWorker.ready.then(() => true)')
    await page.reload()
    await main().getByText('位置编码有什么用').first().waitFor()
    await expect.poll(() => page.evaluate('navigator.serviceWorker.controller !== null')).toBe(true)
    const kept = await page.evaluate<string[]>(`(async () => {
      const paths = []
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) {
          paths.push(new URL(request.url).pathname)
        }
      }
      return paths
    })()`)
    expect(kept).toContain('/')
    expect(kept.some((path) => path.startsWith('/assets/'))).toBe(true)
    // What the person asked and holds comes only from the service.
    expect(kept.filter((path) => path.startsWith('/api') || path.startsWith('/mcp'))).toEqual([])
  }, 60_000)

  it('opens a link made when review and understanding lived in the side column', async () => {
    await newSpace('机器学习')
    await page.waitForURL(/\/new/)
    const space = /#\/spaces\/([^/]+)\//.exec(page.url())?.[1] ?? ''
    const origin = service.workspaceUrl ?? ''

    await page.goto(`${origin}?side=pending#/spaces/${space}/new`)
    await page.waitForURL(/#\/spaces\/[^/]+\/review/)
    await main().getByRole('heading', { name: '待确认' }).waitFor()
    expect(page.url()).not.toContain('side=')

    await page.goto(`${origin}?side=understood&node=node_gone#/spaces/${space}/new`)
    await page.waitForURL(/#\/spaces\/[^/]+\/understanding\/node_gone/)
    await main().getByRole('heading', { name: '我的理解' }).waitFor()
    expect(page.url()).not.toContain('node=')
  }, 60_000)

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

  it('opens a space that has something in it on the overview, not on a question box', async () => {
    await newSpace('机器学习')
    await upload('编码笔记.md')
    await ask('位置编码有什么用')
    const conversation = page.url()
    await page.getByRole('button', { name: '提炼成待确认的理解' }).first().click()
    await page.getByRole('button', { name: /待确认（[1-9]/ }).waitFor()
    // Distilling leaves the person in the conversation.
    expect(page.url()).toBe(conversation)

    await page.getByRole('button', { name: '机器学习', exact: true }).click()
    await page.waitForURL(/#\/spaces\/[^/]+$/)
    await main()
      .getByRole('heading', { name: /等你确认（[1-9]/ })
      .waitFor()
    await main().getByText('练习正确率').waitFor()
    expect(await page.getByLabel('你的问题').count()).toBe(0)
    expect(await page.getByRole('tab', { name: '学习状态' }).count()).toBe(0)

    // The overview survives a refresh rather than sliding on to the last conversation.
    const overview = page.url()
    await page.reload()
    await main()
      .getByRole('heading', { name: /等你确认（[1-9]/ })
      .waitFor()
    expect(page.url()).toBe(overview)

    await main().getByRole('button', { name: '去确认' }).click()
    await page.waitForURL(/#\/spaces\/[^/]+\/review/)
    await main().getByRole('button', { name: '确认为我的理解' }).first().waitFor()
    await page.goBack()
    await page.waitForURL(overview)

    await main().getByRole('button', { name: '回到“位置编码有什么用”' }).click()
    await main().getByText('位置编码有什么用').first().waitFor()
    expect(page.url().split('#')[1]).toBe(conversation.split('#')[1])
    await page.getByLabel('你的问题').waitFor()
  }, 120_000)

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
