import { exec } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startService, type EpistemeService } from '@episteme/service'
import { SimulatedModel, workbenchProfile } from '@episteme/workbench'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire, type McpWire } from './mcp-wire.js'

/**
 * What a host agent recorded, read by the person on the page: a session's results rather than its transcript, and
 * their own confirmation as the only thing that moves what they hold.
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
  throw new Error('CI needs Edge or Chrome for the outcomes journey')
}

// A browser context can take longer than the default ten seconds while other test files are building.
const HOOK_TIMEOUT = 60_000

const WRONG = '校验和不对时跳过这条，继续恢复后面的'

describe.skipIf(browser === undefined)('outcomes in a browser', () => {
  let built: string
  let directory: string
  let service: EpistemeService
  let host: McpWire
  let page: Page
  let sent = 0
  const errors: string[] = []

  const write = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    sent += 1
    const answer = await host.call(name, { submission: `sub-${sent}`, ...args })
    expect(answer.isError ?? false, JSON.stringify(answer.structuredContent)).toBe(false)
    return answer.structuredContent as T
  }

  const said = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const answer = await host.call(name, args)
    expect(answer.isError ?? false, JSON.stringify(answer.structuredContent)).toBe(false)
    return answer.structuredContent as T
  }

  beforeAll(async () => {
    // Its own copy: another file's build empties a shared dist under a page that is still loading.
    built = await mkdtemp(join(tmpdir(), 'episteme-web-build-'))
    await promisify(exec)(
      `pnpm --filter @episteme/workbench-web exec vite build --outDir "${built}" --emptyOutDir`,
      { cwd: process.cwd() },
    )
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await rm(built, { recursive: true, force: true })
  })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-outcomes-'))
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel() }),
      workspace: built,
    })
    host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
    page = await (await browser!.newContext()).newPage()
    page.on('pageerror', (error) => errors.push(error.message))
  }, HOOK_TIMEOUT)

  afterEach(async () => {
    await page.context().close()
    await service.close()
    await rm(directory, { recursive: true, force: true })
    expect(errors).toEqual([])
  }, HOOK_TIMEOUT)

  it('shows what a host recorded, keeps the words out, and leaves confirming to the person', async () => {
    const { space } = await write<{ space: { id: string; scope: string } }>('learn_space_open', {
      name: '潮汐缓存',
    })
    const { thread } = await said<{ thread: { id: string } }>('thread_open', {
      title: '第一天',
      scope: space.scope,
    })
    const { plan } = await write<{
      plan: { id: string; version: number; steps: { id: string; objective: string }[] }
    }>('learn_plan_start', {
      space: space.id,
      topic: '潮汐缓存协议',
      thread: thread.id,
      steps: [{ activity: 'retell', label: '中潮层崩溃重放' }],
    })
    const objective = plan.steps[0]?.objective ?? ''
    const step = plan.steps[0]?.id ?? ''
    const { plan: entered } = await write<{ plan: { version: number } }>('learn_step', {
      plan: plan.id,
      planVersion: plan.version,
      step,
      action: 'enter',
    })
    const at = { plan: plan.id, planVersion: entered.version, objective, step }
    await write('learn_observe', {
      ...at,
      kind: 'move',
      activity: 'retell',
      reason: '先让他自己说',
    })
    const { turn } = await said<{ turn: { id: string } }>('thread_append', {
      thread: thread.id,
      speaker: 'learner',
      text: WRONG,
    })
    await write('learn_observe', {
      ...at,
      kind: 'attempt',
      thread: thread.id,
      turn: turn.id,
      quote: WRONG,
      verdict: 'contradicts',
      reason: '协议要求遇到错误就停下',
      diagnosis: '把校验失败当成可跳过',
    })
    const { suggestion } = await said<{ suggestion: { id: string } }>('propose', {
      kind: 'claim',
      label: '校验和不对时必须停止重放',
      rationale: '资料第三节',
      scope: space.scope,
    })
    await write('learn_observe', { ...at, kind: 'candidate', suggestion: suggestion.id })

    await said('propose', {
      kind: 'claim',
      label: '日志保留九小时',
      rationale: '资料第二节',
      scope: space.scope,
    })

    await page.goto(service.workspaceUrl ?? '')
    await page.getByRole('heading', { name: '现在的情况' }).waitFor()
    const main = page.getByRole('main')
    const reading = main.locator('.reading')
    await reading.getByText('还有缺口：把校验失败当成可跳过').waitFor()
    await reading.getByText('有一条等你确认').waitFor()
    await main.getByText('另有 1 条候选没有关联到上面的学习目标').waitFor()
    await main.getByText('Agent 选了“说说你的理解”：先让他自己说').waitFor()
    await main.getByText('提出一条理解：校验和不对时必须停止重放（等你确认）').waitFor()
    await main.getByText('0 步做完，还剩 1 步').waitFor()
    const shown = await main.innerText()
    expect(shown).not.toContain(WRONG)
    expect(shown).not.toContain('actor_')

    await main.getByRole('button', { name: '去确认' }).click()
    const confirm = page.getByRole('button', { name: '确认为我的理解' })
    await page
      .locator('*')
      .filter({ hasText: '校验和不对时必须停止重放', has: confirm })
      .last()
      .getByRole('button', { name: '确认为我的理解' })
      .click()
    await reading.getByText('你确认过').waitFor()
    // Confirming says nothing about the attempts: the gap stays what they showed.
    await reading.getByText('还有缺口：把校验失败当成可跳过').waitFor()

    // The words are one deliberate step away.
    await main.getByRole('button', { name: '看原始对话' }).click()
    await main.getByText(WRONG).waitFor()
  })
})
