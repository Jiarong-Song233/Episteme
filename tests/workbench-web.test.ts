import { exec } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { mcpWire } from './mcp-wire.js'

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

// A browser context can take longer than the default ten seconds while other test files are building.
const HOOK_TIMEOUT = 60_000

const NOTES = `# 位置编码

位置编码把序列的顺序告诉模型。

# 注意力

注意力机制让词元彼此关联。
`

describe.skipIf(browser === undefined)('the workbench in a browser', () => {
  let built: string
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
      workspace: built,
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
    await page.getByRole('button', { name: /^材料（/ }).click()
    await page.locator('.upload input').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(content),
    })
  }

  /** Adds a material on the materials page and goes back to learning, the way a person would. */
  const addMaterial = async (name: string, content: string): Promise<void> => {
    await upload(name, content)
    await page.locator('.material-list').getByRole('button', { name, exact: true }).waitFor()
    await page.getByRole('button', { name: /^材料（[1-9]/ }).waitFor()
    await page.getByRole('button', { name: '学习', exact: true }).click()
  }

  const ask = async (question: string): Promise<void> => {
    await page.getByLabel('你的问题').fill(question)
    await page.getByRole('button', { name: '提问' }).click()
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
    await addMaterial('编码笔记.md', NOTES)

    await ask('位置编码有什么用')
    const cite = page.getByRole('button', { name: /查看引用 1：编码笔记\.md/ })
    await cite.waitFor()

    // The citation opens the source at the very passage.
    await cite.click()
    await expect.poll(() => page.locator('mark').textContent()).toContain('位置编码把序列的顺序')
    expect(await page.locator('mark').textContent()).not.toContain('注意力机制')

    // Nothing is understanding until the person says so.
    await page.getByRole('button', { name: '我的理解（0）' }).waitFor()
    await page.getByRole('button', { name: '提炼成待确认的理解' }).click()
    await page.getByRole('button', { name: '待确认（1）' }).click()
    await page.getByRole('button', { name: '我的理解（0）' }).waitFor()

    await page.getByRole('button', { name: '确认为我的理解' }).click()
    await page.getByRole('button', { name: '我的理解（1）' }).click()
    await page.locator('.understood li', { hasText: '位置编码' }).waitFor()

    await close()
    await open()

    await page.getByRole('heading', { name: '机器学习' }).waitFor()
    await page.getByRole('button', { name: '材料（1）' }).click()
    await page
      .locator('.material-list')
      .getByRole('button', { name: '编码笔记.md', exact: true })
      .waitFor()
    await page.getByRole('button', { name: '概览', exact: true }).click()
    await page.getByRole('button', { name: '位置编码有什么用', exact: true }).waitFor()
    // Coming back opens on the overview, one step from the conversation.
    await page.getByRole('button', { name: '回到“位置编码有什么用”' }).click()
    await page.locator('.question', { hasText: '位置编码有什么用' }).waitFor()
    await page.getByRole('button', { name: /查看引用 1/ }).waitFor()
    await page.getByRole('button', { name: '我的理解（1）' }).click()
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
    await addMaterial('a.md', NOTES)

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

    await addMaterial('a.md', NOTES)
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
    await addMaterial('a.md', NOTES)
    await ask('位置编码有什么用')
    const cite = page.getByRole('button', { name: /查看引用 1/ })
    await cite.waitFor()

    await page.getByRole('button', { name: '材料（1）' }).click()
    const remove = page.getByRole('button', { name: '删除 a.md' })
    await remove.click()
    await remove.click()
    await expect.poll(() => page.getByRole('button', { name: 'a.md', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: '材料（0）' }).waitFor()
    await page.getByRole('button', { name: '学习', exact: true }).click()

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
    // With plans already in the space, the form waits behind a link.
    const adding = page.getByRole('button', { name: '新建学习计划' })
    if ((await adding.count()) > 0) await adding.click()
    await page.getByLabel('想学什么').fill(topic)
    await page.getByLabel('可用时间').fill(String(minutes))
    await page.getByRole('radio', { name: mode }).check()
    await page.getByRole('button', { name: '生成计划' }).click()
    await page.getByRole('heading', { name: topic }).waitFor()
  }

  it('learns one material both ways: edits, answers, pauses, restarts and sees the record', async () => {
    await open()
    await newSpace('机器学习')
    await addMaterial('a.md', NOTES)

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
    await page.getByRole('button', { name: /待确认（[1-9]/ }).waitFor()

    // Pausing survives a reload.
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByText('已暂停。进度都保存着。').waitFor()
    await page.reload()
    await page.getByText('已暂停。进度都保存着。').waitFor()
    await page.getByRole('button', { name: '继续学习' }).click()

    await advanceTo(page.getByText('这个计划结束了'))
    await page.getByRole('button', { name: '看这个空间的概览' }).click()
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
    await page.getByRole('button', { name: '回到“注意力”' }).click()
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
    await addMaterial('a.md', NOTES)
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

  /** Says a thing in the conversation, makes it the person's own, and opens what it became. */
  const holdOwnWords = async (words: string): Promise<void> => {
    await ask(words)
    const turn = page.locator('.learner-turn', { hasText: words })
    await turn.getByRole('button', { name: '这是我的理解' }).click()
    await page.getByRole('button', { name: '待确认（1）' }).click()
    await page.locator('.pending').getByText('你的原话').first().waitFor()
    await page.getByRole('button', { name: '确认为我的理解' }).click()
    await page.getByRole('button', { name: /我的理解（/ }).click()
    await page.locator('.node-row', { hasText: words }).click()
    await page.locator('.node-label', { hasText: words }).waitFor()
  }

  it('marks the words an agent relayed, from the conversation to what the person holds', async () => {
    const said = '位置编码可有可无'
    const relayed = '位置编码告诉模型词的顺序'
    const unknown = '注意力让词元彼此关联'
    await open()
    await newSpace('机器学习')
    await addMaterial('a.md', NOTES)
    await ask(said)
    await page.locator('.learner-turn', { hasText: said }).waitFor()

    const running = service as EpistemeService
    const listed = await fetch(`${running.apiUrl}/threads`, {
      headers: { authorization: `Bearer ${running.humanToken ?? ''}` },
    })
    const { threads } = (await listed.json()) as { threads: readonly { id: string }[] }
    const thread = threads[0]?.id ?? ''
    const host = mcpWire(() => running.mcpUrl, { name: 'Claude Code', version: '1' })
    await host.call('thread_append', { thread, speaker: 'learner', text: relayed })
    const sent = await fetch(`${running.apiUrl}/threads/${thread}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speaker: 'learner', text: unknown }),
    })
    expect(sent.status).toBe(200)

    await page.reload()
    const relayedTurn = page.locator('.learner-turn', { hasText: relayed })
    await relayedTurn.getByText('Agent 转述').waitFor()
    await page.locator('.learner-turn', { hasText: unknown }).getByText('来源未记录').waitFor()
    const ownTurn = page.locator('.learner-turn', { hasText: said })
    expect(await ownTurn.locator('.turn-source').count()).toBe(0)

    await relayedTurn.getByRole('button', { name: '这是我的理解' }).click()
    await page.getByRole('button', { name: '待确认（1）' }).click()
    await page.locator('.pending').getByText('Agent 转述').first().waitFor()
    expect(await page.locator('.pending').getByText('你的原话').count()).toBe(0)
    await page.getByRole('button', { name: '确认为我的理解' }).click()
    await page.getByRole('button', { name: /我的理解（/ }).click()
    await page.locator('.node-row', { hasText: relayed }).click()
    await page.locator('.node-detail .hint', { hasText: 'Agent 转述' }).first().waitFor()
    await page.locator('.trail').getByText('Agent 转述的话，经你确认').waitFor()
  }, 60_000)

  it('walks one understanding from proposed to challenged, revised and used again', async () => {
    const said = '位置编码可有可无'
    const better = '位置编码告诉模型词的顺序，不可缺少'
    await open()
    await newSpace('机器学习')
    await addMaterial('a.md', NOTES)

    await holdOwnWords(said)
    await page.locator('.node-detail').getByText('你的原话').waitFor()
    await page.locator('.trail').getByText('你提出这一条').waitFor()

    // Confirming it says nothing about mastering it, and what the person records is theirs.
    await page.getByText('确认一条理解，不等于你已经掌握它').waitFor()
    await page.getByLabel('确信程度').selectOption({ index: 1 })
    await page.locator('.trail').getByText('确信程度：').waitFor()

    // A challenge changes nothing held until the person answers it.
    await page.getByRole('button', { name: '提出质疑' }).click()
    await page.getByLabel('你的质疑').fill('没有它，模型怎么知道先后？')
    await page.getByRole('button', { name: '记下这条质疑' }).click()
    await page.locator('.challenge', { hasText: '怎么知道先后' }).waitFor()
    await page.getByRole('button', { name: '我的理解（1）' }).waitFor()

    await page.getByRole('button', { name: '它说得对，修正' }).click()
    await page.getByLabel('现在你怎么想').fill(better)
    await page.getByLabel('为什么改').fill('材料说它传递顺序')
    await page.getByRole('button', { name: '保存修正' }).click()

    // The new wording opens, knowing where it came from; the old one stays, marked, with its whole trail.
    await page.locator('.node-label', { hasText: better }).waitFor()
    await page
      .locator('.trail', { hasText: '修正而来' })
      .getByRole('button', { name: said })
      .click()
    await page.locator('.node-label', { hasText: said }).waitFor()
    await page.locator('.marks').getByText('已修正').waitFor()
    await page.locator('.trail').getByText('你据此修正了这一条').waitFor()
    await page.getByRole('button', { name: '我的理解（1）' }).waitFor()

    // Back to the words it came from.
    await page.getByRole('button', { name: '回到当时的对话' }).click()
    await page.locator('.learner-turn[data-focused="true"]', { hasText: said }).waitFor()
    await page
      .locator('.learner-turn', { hasText: said })
      .getByRole('button', { name: '已记成理解，去看看' })
      .waitFor()

    // A new conversation brings up the revised wording only, and not as evidence.
    await page.getByRole('button', { name: '开始新对话' }).click()
    await ask('位置编码有什么用')
    const recalled = page.locator('.recalled')
    await recalled.getByRole('button', { name: better }).waitFor()
    expect(await recalled.textContent()).not.toContain(said)
    await recalled.getByText('不是材料').waitFor()

    // All of it is still there after a restart.
    await close()
    await open()
    await page.getByRole('button', { name: '我的理解（1）' }).click()
    await page.locator('.node-row', { hasText: better }).click()
    await page
      .locator('.trail', { hasText: '修正而来' })
      .getByRole('button', { name: said })
      .waitFor()
    await page.locator('.trail').getByText('材料说它传递顺序').waitFor()
  }, 120_000)

  it('keeps a contradiction open, takes a model challenge, and withdraws', async () => {
    const model: ModelClient = {
      name: 'stub',
      simulated: false,
      complete: (messages) =>
        Promise.resolve({
          text: messages[0]?.content.includes('提出一个质疑')
            ? '{"challenge":"没有它，模型真的看不出先后吗？","quote":"位置编码把序列的顺序告诉模型。"}'
            : '位置编码把序列的顺序告诉模型。[1]',
        }),
    }
    await open(model)
    await newSpace('机器学习')
    await addMaterial('a.md', NOTES)

    await holdOwnWords('位置编码是必需的')
    await page.getByRole('button', { name: '让模型质疑' }).click()
    const challenge = page.locator('.challenge', { hasText: '真的看不出先后' })
    await challenge.getByText('位置编码把序列的顺序告诉模型').waitFor()
    await challenge.getByRole('button', { name: '不成立，放下' }).click()
    await page.locator('.trail').getByText('你放下了它').waitFor()
    await page.getByRole('button', { name: '全部理解' }).click()

    // Understanding has its own page now: the conversation is one step back in learning.
    await page.getByRole('button', { name: '学习', exact: true }).click()
    await holdOwnWords('位置编码不是必需的')
    await page.getByRole('button', { name: '和另一条矛盾' }).click()
    await page.getByRole('button', { name: '记下这个矛盾' }).click()
    await page.locator('.marks').getByText('未解决的矛盾').waitFor()
    await page.locator('.relations').getByRole('button', { name: '位置编码是必需的' }).click()
    await page.locator('.marks').getByText('未解决的矛盾').waitFor()

    // Neither is forced out, and the conversation says so when it brings one up.
    await page.getByRole('button', { name: '我的理解（2）' }).waitFor()
    await page.getByRole('button', { name: '全部理解' }).click()
    await page.locator('.map circle').first().waitFor()
    await page.getByRole('button', { name: '开始新对话' }).click()
    await ask('位置编码是必需的吗')
    await page.locator('.recalled').getByText('未解决的矛盾').first().waitFor()

    await page.locator('.recalled button').first().click()
    await page.getByRole('button', { name: '撤回', exact: true }).click()
    await page.getByRole('button', { name: '我的理解（1）' }).waitFor()
    await page.getByRole('button', { name: '恢复', exact: true }).click()
    await page.getByRole('button', { name: '我的理解（2）' }).waitFor()
  }, 120_000)

  it('fits a phone', async () => {
    await open()
    await page.setViewportSize({ width: 375, height: 812 })
    await newSpace('机器学习')
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: '原文', exact: true }).click()
    await page.getByText('点回答里的角标').waitFor()
    await page.getByRole('button', { name: '空间', exact: true }).click()
    await page.getByRole('button', { name: '我的理解（0）' }).click()
    await page.getByRole('heading', { name: '我的理解' }).waitFor()
  }, 60_000)
})
