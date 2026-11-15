import { exec } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startService, type EpistemeService } from '@episteme/service'
import {
  Agents,
  SimulatedModel,
  workbenchProfile,
  type AgentEnvironment,
  type Space,
} from '@episteme/workbench'
import { chromium, type Browser, type Page } from 'playwright-core'
import { mcpWire } from './mcp-wire.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/** The published first-level pages, driven from a seeded graph and the service's built page. */

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
const scene = '/scene/workbench'
const NOTES = `# 位置编码

位置编码把序列的顺序告诉模型。没有它，注意力机制看不出词的先后。

# 自注意力

注意力机制让词元根据查询和键的相似度加权。
`

const jsonl = (...lines: unknown[]): string =>
  `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`

const AGENT_TRANSCRIPT = jsonl(
  {
    type: 'user',
    message: {
      content:
        '为什么 Transformer 需要位置编码？位置编码把序列的顺序告诉模型。注意力机制让词元根据查询和键的相似度加权。',
    },
    cwd: 'D:\\work\\preview',
    timestamp: '2026-11-14T10:00:00Z',
  },
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: '因为自注意力本身不区分词的顺序。',
        },
      ],
    },
    timestamp: '2026-11-14T10:00:05Z',
  },
  {
    type: 'custom-title',
    customTitle: '位置编码与注意力',
    sessionId: 'vision-client',
  },
)

interface Reply<T> {
  readonly status: number
  readonly body: T
}

interface Seed {
  readonly space: Space
  readonly pendingLabel: string
  readonly plan: string
}

interface State {
  readonly nodes: readonly { readonly nodeId: string; readonly label: string }[]
  readonly pending: readonly {
    readonly id: string
    readonly proposal: { readonly label?: string }
  }[]
}

async function call<T>(service: EpistemeService, path: string, body?: unknown): Promise<Reply<T>> {
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
  return { status: response.status, body: payload }
}

const stateOf = (service: EpistemeService, space: string): Promise<State> =>
  call<State>(service, `${scene}/understanding?space=${space}`).then((reply) => reply.body)

async function propose(
  service: EpistemeService,
  space: string,
  question: string,
): Promise<{ readonly id: string; readonly label: string }> {
  const asked = await call<{ thread: string; reply: string }>(service, `${scene}/ask`, {
    space,
    question,
  })
  const offered = await call<{ suggestions: readonly { id: string }[] }>(
    service,
    `${scene}/candidates`,
    { space, thread: asked.body.thread, reply: asked.body.reply },
  )
  const suggestion = offered.body.suggestions[0]
  if (suggestion === undefined) throw new Error(JSON.stringify(offered.body))
  const pending = await stateOf(service, space)
  const label = pending.pending.find((item) => item.id === suggestion.id)?.proposal.label
  if (label === undefined) throw new Error('The candidate has no label')
  return { id: suggestion.id, label }
}

async function seed(service: EpistemeService): Promise<Seed> {
  const created = await call<{ space: Space }>(service, `${scene}/spaces`, {
    name: '机器学习基础',
  })
  const space = created.body.space
  await call(service, `${scene}/materials`, {
    space: space.id,
    fileName: '编码笔记.md',
    contentBase64: Buffer.from(NOTES).toString('base64'),
  })
  const first = await propose(service, space.id, '位置编码有什么用')
  await call(service, '/suggestions/decide', { id: first.id, action: 'accept' })
  const second = await propose(service, space.id, '注意力机制让词元彼此关联')
  const planned = await call<{ plan: { id: string } }>(service, `${scene}/plans`, {
    space: space.id,
    topic: '神经网络训练基础',
    minutes: 30,
    workflow: 'speedrun',
  })
  return { space, pendingLabel: second.label, plan: planned.body.plan.id }
}

interface DetailedNode {
  readonly nodeId: string
  readonly label: string
  readonly understanding: readonly { readonly id: string; readonly level: string }[]
}

interface Plan {
  readonly id: string
  readonly version: number
  readonly steps: readonly { readonly id: string; readonly objective: string }[]
}

const conflictOf = async (
  service: EpistemeService,
  space: string,
  label: string,
): Promise<string | undefined> => {
  const state = await call<{ nodes: readonly DetailedNode[] }>(
    service,
    `${scene}/understanding?space=${space}`,
  )
  return state.body.nodes
    .find((node) => node.label === label)
    ?.understanding.find((entry) => entry.id === 'conflict')?.level
}

const HELD_DOUBT = '校验和不对时必须停止恢复'

/** A space where the person holds a claim, then a wrong attempt leaves a pending "conflict: suspected" doubt. */
async function seedDoubt(
  service: EpistemeService,
): Promise<{ space: { id: string }; held: string }> {
  const host = mcpWire(() => service.mcpUrl, { name: 'Claude Code', version: '1' })
  let n = 0
  const made = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await host.call(name, { submission: `s-${++n}`, ...args })
    if (result.isError === true) throw new Error(`${name}: ${JSON.stringify(result)}`)
    return result.structuredContent as T
  }
  const plain = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await host.call(name, args)
    if (result.isError === true) throw new Error(`${name}: ${JSON.stringify(result)}`)
    return result.structuredContent as T
  }
  const { space } = await made<{ space: { id: string; scope: string } }>('learn_space_open', {
    name: '冲突回归',
  })
  const { thread } = await plain<{ thread: { id: string } }>('thread_open', {
    title: '第一天',
    scope: space.scope,
  })
  const started = await made<{ plan: Plan }>('learn_plan_start', {
    space: space.id,
    topic: '崩溃恢复',
    thread: thread.id,
    steps: [{ activity: 'retell', label: '校验失败时怎么办' }],
  })
  const { plan } = await made<{ plan: Plan }>('learn_step', {
    plan: started.plan.id,
    planVersion: started.plan.version,
    step: started.plan.steps[0]?.id,
    action: 'enter',
  })
  const objective = plan.steps[0]?.objective ?? ''
  const { suggestion } = await plain<{ suggestion: { id: string } }>('propose', {
    kind: 'claim',
    label: HELD_DOUBT,
    rationale: '本人这样说',
    scope: space.scope,
  })
  await made('learn_observe', {
    plan: plan.id,
    planVersion: plan.version,
    objective,
    kind: 'candidate',
    suggestion: suggestion.id,
  })
  await call(service, '/suggestions/decide', { id: suggestion.id, action: 'accept' })
  const { turn } = await plain<{ turn: { id: string } }>('thread_append', {
    thread: thread.id,
    speaker: 'learner',
    text: '校验和不对时跳过这条',
  })
  await made('learn_observe', {
    plan: plan.id,
    planVersion: plan.version,
    objective,
    kind: 'move',
    activity: 'retell',
    reason: '先让他自己说',
  })
  await made('learn_observe', {
    plan: plan.id,
    planVersion: plan.version,
    objective,
    kind: 'attempt',
    thread: thread.id,
    turn: turn.id,
    quote: '校验和不对时跳过这条',
    verdict: 'contradicts',
    reason: '依据协议第三节',
    diagnosis: '把校验失败当成可跳过',
  })
  return { space: { id: space.id }, held: HELD_DOUBT }
}

describe('the published workbench in a browser', () => {
  let built: string
  let directory: string
  let service: EpistemeService
  let page: Page
  let mcpUrl = ''
  const errors: string[] = []
  const badResponses: string[] = []

  beforeAll(async () => {
    built = await mkdtemp(join(tmpdir(), 'episteme-vision-web-'))
    await promisify(exec)(
      `pnpm --filter @episteme/workbench-web exec vite build --outDir "${built}" --emptyOutDir`,
    )
  }, 180_000)

  afterAll(async () => {
    await installed.close()
    await rm(built, { recursive: true, force: true, maxRetries: 5 })
  })

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'episteme-vision-graph-'))
    errors.length = 0
    badResponses.length = 0
    mcpUrl = ''
    const home = join(directory, 'home')
    const sessions = join(home, '.claude', 'projects', 'D--work-preview')
    await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, 'vision-client.jsonl'), AGENT_TRANSCRIPT)
    const environment: AgentEnvironment = {
      home,
      platform: process.platform,
      appData: join(home, 'AppData'),
      env: {},
      run: () => Promise.resolve({ ok: false, output: '' }),
      bridge: { command: 'node', args: ['bridge.js'] },
    }
    const agents = await Agents.open(join(directory, 'agents.json'), environment, () => mcpUrl)
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({
        model: new SimulatedModel(),
        agents,
        agentEnvironment: environment,
      }),
      workspace: built,
    })
    mcpUrl = service.mcpUrl
    const context = await installed.newContext({ viewport: { width: 1280, height: 900 } })
    page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('response', (response) => {
      if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`)
    })
  }, 60_000)

  afterEach(async () => {
    await page.context().close()
    await service.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
    expect(errors).toEqual([])
    expect(badResponses).toEqual([])
  }, 60_000)

  it('opens every first-level page, follows real seed changes, confirms a candidate and saves an answer', async () => {
    const seeded = await seed(service)
    const { space } = seeded
    const before = await stateOf(service, space.id)
    const firstMaterials = await call<{ materials: readonly { id: string }[] }>(
      service,
      `${scene}/materials?space=${space.id}`,
    )
    await page.goto(`${service.workspaceUrl ?? ''}#/desk/${space.id}`)
    await page.getByRole('heading', { name: '今日概览' }).waitFor()
    await page.waitForFunction(
      `(count) => Number(document.querySelector('[data-stat="materials"]')?.textContent) === count`,
      firstMaterials.body.materials.length,
    )
    await page.waitForFunction(
      `(count) => Number(document.querySelector('[data-stat="nodes"]')?.textContent) === count`,
      before.nodes.length,
    )
    expect(await page.locator('[data-stat="materials"]').textContent()).toBe(
      String(firstMaterials.body.materials.length),
    )
    expect(await page.locator('[data-stat="nodes"]').textContent()).toBe(
      String(before.nodes.length),
    )

    const firstLevel = [
      { label: '工作台', kind: 'desk', heading: '今日概览' },
      { label: '学习空间', kind: 'learning-spaces', heading: '学习空间' },
      { label: '知识网络', kind: 'network', heading: '理解网络图谱' },
      { label: '审阅中心', kind: 'review-center', heading: '候选理解详情' },
      { label: '学习流程', kind: 'learning-flow', heading: '步骤进度' },
      { label: '共享成果', kind: 'shared-outcomes', heading: '共享成果' },
      { label: '我的资料', kind: 'my-materials', heading: '我的资料' },
      { label: '客户端', kind: 'client', heading: '统一全局记忆' },
    ] as const
    for (const view of firstLevel) {
      await page.getByRole('link', { name: view.label, exact: true }).click()
      await page.waitForFunction(
        `(kind) => document.querySelector('.vision-shell')?.getAttribute('data-page') === kind`,
        view.kind,
      )
      await page.waitForFunction(
        `(label) => document.querySelector('.vision-nav-link[aria-current="page"]')?.getAttribute('aria-label') === label`,
        view.label,
      )
      expect(
        await page.locator('.vision-nav-link[aria-current="page"]').getAttribute('aria-label'),
      ).toBe(view.label)
      expect(await page.locator('.vision-card:visible').count()).toBeGreaterThan(0)
      expect(new URL(page.url()).hash.length).toBeGreaterThan(1)
    }
    for (const view of firstLevel) {
      await page.getByRole('link', { name: view.label, exact: true }).click()
      await page.waitForFunction(
        `(kind) => document.querySelector('.vision-shell')?.getAttribute('data-page') === kind`,
        view.kind,
      )
      await page.getByRole('heading', { name: view.heading, exact: false }).first().waitFor()
    }

    await page.getByRole('link', { name: '工作台', exact: true }).click()
    await call(service, `${scene}/materials`, {
      space: space.id,
      fileName: '优化笔记.md',
      contentBase64: Buffer.from('梯度下降沿损失函数的梯度更新参数。').toString('base64'),
    })
    const next = await propose(service, space.id, '梯度下降为什么能更新参数')
    await call(service, '/suggestions/decide', { id: next.id, action: 'accept' })
    const after = await stateOf(service, space.id)
    const afterMaterials = await call<{ materials: readonly { id: string }[] }>(
      service,
      `${scene}/materials?space=${space.id}`,
    )
    await page.reload()
    await page.getByRole('heading', { name: '今日概览' }).waitFor()
    await page.waitForFunction(
      `(count) => Number(document.querySelector('[data-stat="nodes"]')?.textContent) === count`,
      after.nodes.length,
    )
    expect(await page.locator('[data-stat="materials"]').textContent()).toBe(
      String(afterMaterials.body.materials.length),
    )
    expect(after.nodes.length).toBeGreaterThan(before.nodes.length)
    expect(afterMaterials.body.materials.length).toBeGreaterThan(
      firstMaterials.body.materials.length,
    )
    for (const node of after.nodes) {
      await page.locator('.vision-network-preview').getByText(node.label).first().waitFor()
    }

    await page.getByRole('link', { name: '知识网络', exact: true }).click()
    await page.getByRole('heading', { name: '理解网络图谱' }).waitFor()
    for (const tab of ['概念', '关系', '时间线', '来源']) {
      await page.getByRole('tab', { name: tab }).click()
      expect(await page.getByRole('tab', { name: tab }).getAttribute('aria-selected')).toBe('true')
    }
    await page.getByRole('button', { name: '列表视图' }).click()
    await page.locator('.vision-node-list button').first().waitFor()
    await page.getByRole('button', { name: '图谱视图' }).click()
    await page.locator('.vision-graph').waitFor()
    await page.getByRole('heading', { name: '来源追踪' }).waitFor()
    await page.getByRole('heading', { name: '演化时间线' }).waitFor()

    await page.getByRole('link', { name: '审阅中心', exact: true }).click()
    await page.getByRole('heading', { name: '候选理解队列' }).waitFor()
    await page.getByRole('heading', { name: '候选理解详情' }).waitFor()
    await page.getByRole('heading', { name: '影响预览' }).waitFor()
    await page.getByRole('heading', { name: '来源证据' }).waitFor()
    for (const action of ['接受', '需要修改', '暂不纳入', '合并到已有节点']) {
      await page.getByRole('button', { name: action, exact: true }).waitFor()
    }
    const beforeAccept = await stateOf(service, space.id)
    await page.getByRole('button', { name: '接受', exact: true }).click()
    await page.waitForFunction(
      `(count) => document.querySelectorAll('.vision-candidate-list button').length < count`,
      beforeAccept.pending.length,
    )
    const afterAccept = await stateOf(service, space.id)
    expect(afterAccept.nodes.length).toBe(beforeAccept.nodes.length + 1)
    expect(afterAccept.pending.length).toBe(beforeAccept.pending.length - 1)

    const answer = '注意力机制按查询和键的相似度加权每个词元'
    await page.getByRole('link', { name: '学习流程', exact: true }).click()
    await page.getByRole('heading', { name: '步骤进度' }).waitFor()
    await page.getByRole('heading', { name: '学习进度' }).waitFor()
    await page.getByRole('heading', { name: '当前目标', exact: true }).waitFor()
    await page.getByLabel('你的回答').waitFor()
    const save = page.getByRole('button', { name: '保存为可复用的理解节点' })
    await save.waitFor()
    await page.getByLabel('你的回答').fill(answer)
    await save.click()
    await page.getByText(`已保存为可复用节点：${answer}`).waitFor()
    const afterSave = await stateOf(service, space.id)
    expect(afterSave.nodes.some((node) => node.label === answer)).toBe(true)
    expect(afterSave.nodes.length).toBe(afterAccept.nodes.length + 1)

    await page.reload()
    await page.getByRole('heading', { name: '步骤进度' }).waitFor()
    await page.getByText(answer, { exact: true }).first().waitFor()
    expect(seeded.pendingLabel).not.toBe('')
    expect(seeded.plan).not.toBe('')
  }, 180_000)

  it('refuses an unknown addressed space without exposing another space to writes', async () => {
    const { space } = await seed(service)
    const before = await stateOf(service, space.id)
    for (const kind of ['learning-flow', 'client', 'review-center']) {
      await page.goto(`${service.workspaceUrl ?? ''}#/${kind}/missing-space`)
      await page.getByRole('alert').filter({ hasText: '找不到这个地址里的空间' }).waitFor()
      expect(await page.getByRole('button', { name: '保存为可复用的理解节点' }).count()).toBe(0)
      expect(await page.getByRole('button', { name: '导入为待确认理解' }).count()).toBe(0)
      expect(await page.getByRole('button', { name: '接受', exact: true }).count()).toBe(0)
    }
    expect(await stateOf(service, space.id)).toEqual(before)
    await page.getByRole('link', { name: '返回学习空间' }).click()
    await page.getByRole('heading', { name: '学习空间', exact: true }).first().waitFor()
  })

  it.each([180, 400])(
    'preserves candidate words when merging into a %i-character node',
    async (length) => {
      const { space, pendingLabel } = await seed(service)
      const label = '原'.repeat(length)
      const created = await call<{ node: { nodeId: string } }>(service, '/nodes', {
        label,
        kind: 'claim',
        scope: `workbench:${space.id}`,
      })
      const before = await stateOf(service, space.id)
      await page.goto(`${service.workspaceUrl ?? ''}#/review-center/${space.id}`)
      await page.getByRole('button', { name: '合并到已有节点', exact: true }).click()
      await page.getByLabel('选择已有节点').selectOption(created.body.node.nodeId)
      const combined = `${label}；${pendingLabel}`
      expect(await page.getByLabel('合并后的理解').textContent()).toBe(combined)
      if (length === 400) {
        const refused = page.waitForResponse((response) =>
          response.url().endsWith('/understanding/revise'),
        )
        await page.getByRole('button', { name: '确认合并', exact: true }).click()
        const response = await refused
        expect(response.ok()).toBe(false)
        await page.getByRole('alert').waitFor()
        expect(await stateOf(service, space.id)).toEqual(before)
        const expected = `${response.status()} ${response.url()}`
        expect(badResponses).toEqual([expected])
        badResponses.splice(0, 1)
      } else {
        await page.getByRole('button', { name: '确认合并', exact: true }).click()
        await page.getByText('AI 提出的候选会出现在这里，等待你的决定。').waitFor()
        const after = await stateOf(service, space.id)
        expect(after.nodes.some((node) => node.label === combined)).toBe(true)
        expect(after.pending).toHaveLength(0)
      }
    },
  )

  it('keeps local agents, transcript import and the shared graph on the client page', async () => {
    const seeded = await seed(service)
    const listed = await call<{ sessions: readonly { id: string }[] }>(
      service,
      `${scene}/agent-sessions`,
    )
    expect(listed.body.sessions.length).toBeGreaterThan(0)

    await page.goto(`${service.workspaceUrl ?? ''}#/client/${seeded.space.id}`)
    await page.getByRole('heading', { name: '统一全局记忆' }).waitFor()
    await page.getByRole('heading', { name: '接入本机 Agent' }).waitFor()
    await page.getByRole('heading', { name: '导入对话历史' }).waitFor()
    await page.getByRole('heading', { name: '原有能力' }).waitFor()
    await page.getByRole('heading', { name: '桌面客户端' }).waitFor()

    const connect = page.getByRole('link', { name: '打开接入 Agent 页面' })
    expect(await connect.getAttribute('href')).toBe('#/connect')
    expect(
      await page
        .getByRole('link', { name: /浏览 Agent 会话记录/ })
        .first()
        .getAttribute('href'),
    ).toBe('#/agent-sessions')
    expect(await page.getByRole('link', { name: /打开所有对话/ }).getAttribute('href')).toBe(
      '#/conversations',
    )
    expect(await page.getByRole('link', { name: /处理未分类候选/ }).getAttribute('href')).toBe(
      '#/unfiled',
    )
    expect(await page.getByRole('link', { name: /打开模型设置/ }).getAttribute('href')).toBe(
      '#/model',
    )
    expect(await page.getByRole('link', { name: '浏览共享成果' }).getAttribute('href')).toBe(
      '#/commons',
    )

    const before = await stateOf(service, seeded.space.id)
    await page.getByLabel('选择 Agent 会话').selectOption('0')
    await page.getByRole('button', { name: '导入为待确认理解' }).click()
    await page.getByText(/已导入 \d+ 条候选理解/).waitFor()
    const after = await stateOf(service, seeded.space.id)
    expect(after.pending.length).toBeGreaterThan(before.pending.length)

    await page.getByRole('link', { name: '审阅中心', exact: true }).click()
    await page.getByRole('heading', { name: '候选理解队列' }).waitFor()
    expect(await page.locator('.vision-candidate-list button').count()).toBeGreaterThan(0)
  }, 180_000)

  it('offers only agree or disagree for a state candidate, and agreeing changes only its target state', async () => {
    const { space, held } = await seedDoubt(service)
    const before = await stateOf(service, space.id)
    expect(before.pending).toHaveLength(1)
    expect(await conflictOf(service, space.id, held)).toBeUndefined()

    await page.goto(`${service.workspaceUrl ?? ''}#/review-center/${space.id}`)
    await page.getByRole('heading', { name: '候选理解队列' }).waitFor()
    // The full wording: which understanding, which axis, which level.
    await page.getByText(`${held}：把冲突记为疑似`, { exact: false }).first().waitFor()
    // Only agree / disagree: no free-text change and no merge for a state proposal.
    await page.getByRole('button', { name: '同意', exact: true }).waitFor()
    await page.getByRole('button', { name: '不同意', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '需要修改', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '合并到已有节点', exact: true }).count()).toBe(0)
    // The impact preview says it changes an existing understanding's state, not that it adds a node.
    await page
      .getByText(/改变「.+」这条已有理解的状态/)
      .first()
      .waitFor()

    await page.getByRole('button', { name: '同意', exact: true }).click()
    await page.waitForFunction(
      `(count) => document.querySelectorAll('.vision-candidate-list button').length < count`,
      before.pending.length,
    )
    const after = await stateOf(service, space.id)
    expect(after.nodes.length).toBe(before.nodes.length)
    expect(after.pending).toHaveLength(0)
    expect(await conflictOf(service, space.id, held)).toBe('suspected')
  }, 180_000)

  it('leaves the target state unchanged when a state candidate is declined', async () => {
    const { space, held } = await seedDoubt(service)
    const before = await stateOf(service, space.id)
    await page.goto(`${service.workspaceUrl ?? ''}#/review-center/${space.id}`)
    await page.getByRole('heading', { name: '候选理解队列' }).waitFor()
    await page.getByRole('button', { name: '不同意', exact: true }).click()
    await page.waitForFunction(
      `(count) => document.querySelectorAll('.vision-candidate-list button').length < count`,
      before.pending.length,
    )
    const after = await stateOf(service, space.id)
    expect(after.nodes.length).toBe(before.nodes.length)
    expect(after.pending).toHaveLength(0)
    expect(await conflictOf(service, space.id, held)).toBeUndefined()
  }, 180_000)
})
