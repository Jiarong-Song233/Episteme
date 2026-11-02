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
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
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
  })

  afterEach(async () => {
    await page.context().close()
    await close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
    expect(errors).toEqual([])
  })

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

  /** Moves through a plan until `target` shows, with the buttons a person has. */
  const advanceTo = async (target: Locator): Promise<void> => {
    for (let guard = 0; guard < 80; guard += 1) {
      if ((await target.count()) > 0) return
      const next = page.getByRole('button', { name: '下一步', exact: true })
      if ((await next.count()) > 0 && (await next.isEnabled())) await next.click()
      await page.waitForTimeout(100)
    }
    await target.waitFor({ timeout: 1000 })
  }

  const newPlan = async (topic: string, minutes: number, mode: string): Promise<void> => {
    await page.getByLabel('想学什么').fill(topic)
    await page.getByLabel('可用时间').fill(String(minutes))
    await page.getByRole('radio', { name: mode }).check()
    await page.getByRole('button', { name: '生成计划' }).click()
    await page.getByRole('heading', { name: topic }).waitFor()
  }

  it('learns one material both ways: edits, answers, pauses, restarts and sees the record', async () => {
    await open()
    await newSpace('机器学习')
    await upload('a.md', NOTES)
    await page.getByRole('button', { name: 'a.md', exact: true }).waitFor()

    // A speedrun, and the person changes the plan before starting.
    await newPlan('位置编码', 30, '速通')
    await page.getByRole('button', { name: '修改计划' }).click()
    await page.getByLabel('第 2 步的分钟数').fill('12')
    await page.getByRole('button', { name: '删除第 5 步' }).click()
    await page.getByRole('button', { name: '保存计划' }).click()
    await page.locator('.plan-steps li', { hasText: '12 分钟' }).waitFor()
    await expect.poll(() => page.locator('.plan-steps li').count()).toBe(5)

    await page.getByRole('button', { name: '开始学习' }).click()
    await page
      .getByRole('button', { name: /查看引用 1/ })
      .first()
      .waitFor()
    await advanceTo(page.getByLabel('你的答案'))
    await page.getByLabel('你的答案').fill('不知道')
    await page.getByRole('button', { name: '提交答案' }).click()
    await page.getByText('没答对。正确答案是').waitFor()

    // What the plan said can go to review, like any answer.
    await page.getByRole('button', { name: '提炼成待确认的理解' }).first().click()
    await page.getByRole('tab', { name: /待确认（[1-9]/ }).waitFor()

    // Pausing survives a reload.
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByText('已暂停。进度都保存着。').waitFor()
    await page.reload()
    await page.getByText('已暂停。进度都保存着。').waitFor()
    await page.getByRole('button', { name: '继续学习' }).click()

    await advanceTo(page.getByText('这个计划结束了'))
    await page.getByRole('button', { name: '看学习状态' }).click()
    await page.locator('.status').getByText('0 / 1').waitFor()
    await page.getByText('建议回头看').waitFor()
    await page.getByText('不等于你实际理解了多少').waitFor()

    // The same material, deep, and a restart in the middle of it.
    await newPlan('注意力', 30, '深入')
    await page.getByRole('button', { name: '开始学习' }).click()
    await advanceTo(page.getByLabel('你的想法'))
    await page.locator('.answer', { hasText: '用你自己的话' }).waitFor()
    await page.getByLabel('你的想法').fill('注意力让词元彼此关联')
    await page.getByRole('button', { name: '回复' }).click()
    await page.locator('.question', { hasText: '彼此关联' }).waitFor()
    await page
      .getByRole('button', { name: /查看引用 1/ })
      .last()
      .waitFor()
    await page.getByRole('button', { name: '直接讲给我听' }).click()
    await page.getByRole('button', { name: '这一步够了' }).click()
    await page.locator('.answer', { hasText: '举一个例子' }).waitFor()

    await close()
    await open()
    await page.getByRole('heading', { name: '注意力' }).waitFor()
    await page.locator('.answer', { hasText: '举一个例子' }).waitFor()
    await page.getByRole('button', { name: '这一步够了' }).click()
    await page.getByLabel('你的答案').waitFor()
    await page.getByRole('button', { name: '不答了，往下走' }).click()
    await page.getByLabel('你的想法').waitFor()
    await page.getByRole('button', { name: '这一步够了' }).click()
    await page.getByText('这个计划结束了').waitFor()
    await expect.poll(() => page.locator('li[data-status="skipped"]').count()).toBe(1)
    expect(errors).toEqual([])
  }, 120_000)

  it('offers a retry when the model fails on a step, and keeps the place', async () => {
    let fail = false
    const simulated = new SimulatedModel()
    await open({
      name: 'flaky',
      simulated: true,
      complete(messages) {
        return fail
          ? Promise.reject(new ModelFailure('timeout', '模型超时没有回应。'))
          : simulated.complete(messages)
      },
    })
    await newSpace('机器学习')
    await upload('a.md', NOTES)
    await page.getByRole('button', { name: 'a.md', exact: true }).waitFor()
    await newPlan('位置编码', 15, '速通')
    fail = true
    await page.getByRole('button', { name: '开始学习' }).click()
    await page.getByText('进度已保留').waitFor()
    fail = false
    await page.getByRole('button', { name: '重试' }).click()
    await page
      .getByRole('button', { name: /查看引用 1/ })
      .first()
      .waitFor()
    await expect.poll(() => page.getByText('进度已保留').count()).toBe(0)
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
