#!/usr/bin/env node
/**
 * The first vertical loop (ADR 0019), with a real agent host and a scripted learner.
 *
 * Day one: a real Claude Code session teaches two points from a synthetic document, and the learner gets one wrong on
 * purpose. A person then confirms only the part they stand behind, over REST. Day two: a new session, told nothing of
 * day one, has to find the gap through MCP, choose what to do about it, and record the result. The service's model
 * throws on any call, so whatever teaching happens, the host did it.
 *
 * Two baselines take the place of day two with no Episteme: P0 knows nothing of day one, and P1 has its transcript
 * pasted into the prompt. They answer "does a prompt get you there", not "is this better on average": one run each.
 *
 * The learner is scripted, so this proves the wiring and the record, not that anyone learned anything.
 *
 *   pnpm build && node scripts/vertical-e2e.mjs --out D:/somewhere
 *
 * Spends real model budget: at most --budget dollars per host turn and --total over the run, with a time limit on
 * each turn. The CLI prices a gateway model it does not know by a guess (its costBasis is "unknown"), so these are caps
 * on that estimate; the tokens in the report are what was actually used.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { startService } from '../apps/service/dist/index.js'
import { objectiveIdOf, workbenchProfile } from '../apps/workbench/dist/index.js'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    model: { type: 'string', default: 'auto/deepseek-v4.1-flash' },
    budget: { type: 'string', default: '1.5' },
    total: { type: 'string', default: '6' },
    'timeout-ms': { type: 'string', default: '300000' },
    'skip-baselines': { type: 'boolean', default: false },
    hold: { type: 'boolean', default: false },
  },
})
if (values.out === undefined) throw new Error('--out <directory> is required')

const directory = resolve(values.out)
const hostDirectory = join(directory, 'host')
mkdirSync(hostDirectory, { recursive: true })
const transcript = join(directory, 'mcp-calls.jsonl')

const MATERIAL = readFileSync('docs/research/evaluation/material/潮汐缓存协议.md', 'utf8')
const SPACE = '潮汐缓存'
const POINT_A = '涨潮条件和翻倍上限'
const POINT_B = '中潮层崩溃重放'
const RIGHT = '命中率连续3个周期低于72%就涨潮，浅潮层容量翻倍，最多连续翻两次，之后只告警。'
const WRONG = '校验和不对时跳过这条，继续恢复后面的'
const CORRECTED = '校验和不对就要停下，后面的记录都丢掉，宁可少恢复也不恢复错的。'

let modelCalls = 0
const noModel = {
  name: 'none',
  simulated: false,
  complete: () => {
    modelCalls += 1
    throw new Error('the service called its model')
  },
}

const service = await startService({
  graph: join(directory, 'graph.db'),
  port: 0,
  workspace: resolve('apps/workbench/web/dist'),
  profile: workbenchProfile({ model: noModel }),
})
const target = new URL(service.mcpUrl)

const seen = []
const answers = []
const proxy = createServer((incoming, outgoing) => {
  const chunks = []
  incoming.on('data', (chunk) => chunks.push(chunk))
  incoming.on('end', () => {
    const body = Buffer.concat(chunks)
    let call
    try {
      call = JSON.parse(body.toString('utf8'))
    } catch {
      call = undefined
    }
    if (call?.method === 'tools/call') {
      seen.push({ day: currentDay, tool: call.params?.name, args: call.params?.arguments })
    }
    if (call?.method !== undefined) {
      appendFileSync(
        transcript,
        `${JSON.stringify({ day: currentDay, method: call.method, params: call.params })}\n`,
      )
    }
    const forwarded = request(
      {
        host: target.hostname,
        port: target.port,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, host: target.host },
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
        const parts = []
        answer.on('data', (part) => {
          parts.push(part)
          outgoing.write(part)
        })
        answer.on('end', () => {
          outgoing.end()
          if (call?.method !== 'tools/call') return
          const text = Buffer.concat(parts).toString('utf8')
          const code = /"code":\s*"([a-z_]+)"/.exec(text.replaceAll('\\"', '"'))?.[1]
          if (/"isError":\s*true/.test(text)) {
            answers.push({ day: currentDay, tool: call.params?.name, refused: code })
          }
        })
      },
    )
    forwarded.on('error', () => outgoing.destroy())
    forwarded.end(body)
  })
})
await new Promise((ready) => proxy.listen(0, '127.0.0.1', ready))
const config = join(directory, 'mcp.json')
writeFileSync(
  config,
  JSON.stringify({
    mcpServers: {
      episteme: {
        type: 'http',
        url: `http://127.0.0.1:${proxy.address().port}${target.pathname}`,
      },
    },
  }),
)

const person = async (path, body) => {
  const response = await fetch(`${service.apiUrl}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${service.humanToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  return response.json()
}

// Run from inside another Claude Code, this process carries that session's identity. The host must not inherit it.
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(CLAUDECODE$|CLAUDE_PID$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(name),
  ),
)

let currentDay = 'none'
// A session's cost is reported as a running total across resumes; the CLI's budget applies to each run of it.
const costs = new Map()
const spentSoFar = () => [...costs.values()].reduce((sum, cost) => sum + cost, 0)
let turnsRun = 0
const tools = (day) => seen.filter((each) => each.day === day).map((each) => each.tool)

/** One turn of a host session. The same id again continues it, as a person typing their next line would. */
const hostTurn = (session, first, prompt, withEpisteme = true) =>
  new Promise((done, failed) => {
    if (spentSoFar() >= Number(values.total)) {
      failed(new Error(`spent ${spentSoFar()}, over the limit of ${values.total}`))
      return
    }
    const child = spawn(
      'claude',
      [
        '-p',
        '--model',
        values.model,
        '--max-budget-usd',
        values.budget,
        '--output-format',
        'stream-json',
        '--verbose',
        ...(first ? ['--session-id', session] : ['--resume', session]),
        '--setting-sources',
        'project',
        '--strict-mcp-config',
        ...(withEpisteme ? ['--mcp-config', config, '--allowedTools', 'mcp__episteme'] : []),
        '--tools',
        '""',
        '--max-turns',
        '25',
      ],
      { cwd: hostDirectory, shell: true, env: hostEnvironment, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    // Through a shell, killing the child leaves the host running; a stalled upstream would hold the turn past its limit.
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', `${child.pid}`])
      else child.kill()
    }, Number(values['timeout-ms']))
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', failed)
    child.on('close', (code) => {
      clearTimeout(timer)
      const events = out
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
      turnsRun += 1
      writeFileSync(join(directory, `turn-${turnsRun}-${currentDay}.jsonl`), `${out}\n${err}`)
      const result = events.find((event) => event.type === 'result')
      costs.set(session, result?.total_cost_usd ?? costs.get(session) ?? 0)
      done({
        code,
        stderr: err.slice(0, 1000),
        text: result?.result,
        subtype: result?.subtype,
        ended: result?.terminal_reason,
        sessionCostUsd: result?.total_cost_usd,
        inputTokens: result?.usage?.input_tokens,
        outputTokens: result?.usage?.output_tokens,
        turns: result?.num_turns,
      })
    })
    child.stdin.end(prompt)
  })

const report = { model: values.model, directory, checks: {} }

/**
 * A whole conversation: what the host was told, then each thing the learner says back. Turns reach the report as they
 * finish, so a host that dies midway still leaves what it did.
 */
const conversation = async (name, opening, replies, withEpisteme = true) => {
  const session = randomUUID()
  report[name] = []
  for (const [index, line] of [opening, ...replies].entries()) {
    const turn = await hostTurn(session, index === 0, line, withEpisteme)
    report[name].push(turn)
    if (turn.code !== 0 || !turn.text) {
      throw new Error(`host exited ${turn.code} in ${name}: ${turn.ended ?? turn.stderr}`)
    }
  }
}

const TEACHING = `你在带一个人学习下面这份资料。一次只问一个问题，然后停下等回答，不要替对方回答。\n\n<material>\n${MATERIAL}\n</material>`

const RECORD =
  '记录放在 Episteme MCP 工具里。对方说的话原样记下来；你的判断可以记，但对方是否理解只由对方决定。'

const objectives = async (space) => await person(`/scene/workbench/outcomes?space=${space}`)

const check = (name, passed, detail) => {
  report.checks[name] = detail === undefined ? passed : { passed, detail }
}

try {
  currentDay = 'day1'
  await conversation(
    'day1',
    [
      TEACHING,
      RECORD,
      `这是第一次学。空间名叫“${SPACE}”。要学两个点，先后是：${POINT_A}；${POINT_B}。先把记录准备好，然后问第一个问题。`,
    ].join('\n\n'),
    [
      `${RIGHT}这个点先到这里，直接问下一个点吧。`,
      `${POINT_B}我是这么想的：${WRONG}`,
      `${POINT_A}这部分我觉得我懂了，可以把它整理成一条候选给我确认。${POINT_B}我还没把握，今天先到这里。`,
    ],
  )

  const spaces = (await person('/scene/workbench/spaces')).spaces
  const space = spaces.find((each) => each.name === SPACE)
  check('a space was opened', space !== undefined)
  const idA = objectiveIdOf(space?.id ?? '', POINT_A)
  const idB = objectiveIdOf(space?.id ?? '', POINT_B)
  const afterDayOne = await objectives(space?.id)
  report.afterDayOne = afterDayOne.objectives

  // The person confirms only what is about the part they stand behind.
  const understanding = await person(`/scene/workbench/understanding?space=${space?.id}`)
  report.pendingAfterDayOne = understanding.pending?.map((each) => ({
    id: each.id,
    label: each.proposal?.label,
  }))
  // By what the host tied to the objective: claims it drew from the material wait in the same queue.
  const aboutA = afterDayOne.objectives
    .filter((each) => each.label.includes('涨潮'))
    .flatMap((each) => each.candidates)
    .find((each) => each.status === 'pending')
  check('day one left a candidate on the part understood', aboutA !== undefined, aboutA?.label)
  const unconfirmedB = afterDayOne.objectives.find(
    (each) => each.label.includes('崩溃') && each.gap !== undefined,
  )
  check(
    'a wrong answer opened a gap, before any confirmation',
    unconfirmedB?.gap?.status === 'open',
    unconfirmedB?.gap,
  )
  if (aboutA !== undefined) {
    await person('/suggestions/decide', { id: aboutA.suggestion, action: 'accept' })
  }
  const afterPerson = await objectives(space?.id)
  report.afterConfirming = afterPerson.objectives.map((each) => ({
    label: each.label,
    id: each.id,
    gap: each.gap?.status,
    confirmation: each.confirmation,
  }))

  currentDay = 'day2'
  await conversation(
    'day2',
    [
      TEACHING,
      RECORD,
      '这是一次新的学习。你没有和这个人说过话，也没有之前的聊天记录；之前留下的东西都在 Episteme 里。自己去看，再决定今天做什么，然后问第一个问题。',
    ].join('\n\n'),
    [CORRECTED, '嗯，我现在明白了，这一条可以整理成候选给我确认。今天到这里。'],
  )

  const final = await objectives(space?.id)
  report.final = final
  const listed = (await person(`/scene/workbench/plans?space=${space?.id}`)).plans
  const plans = [...listed].sort((left, right) => left.createdAt - right.createdAt)
  report.plans = plans.map((plan) => ({
    topic: plan.topic,
    status: plan.status,
    version: plan.version,
    steps: plan.steps.map((step) => ({
      block: step.block,
      focus: step.focus,
      objective: step.objective,
      status: step.status,
    })),
  }))
  const firstGap = afterDayOne.objectives.find((each) => each.gap !== undefined)
  const dayTwoPlan = plans.find((plan) => plan !== plans[0])
  const reread = final.objectives.find((each) => each.id === firstGap?.id)

  check('the service model was never called', modelCalls === 0, modelCalls)
  check(
    'a new session read the record before anything else',
    tools('day2').find((tool) => tool.startsWith('learn_')) === 'learn_context',
  )
  // Whether by a new plan or by carrying on the open one: that is the host's to choose.
  check(
    'the new session recorded on the same objective, by id',
    seen.some(
      (each) =>
        each.day === 'day2' &&
        each.args?.kind === 'attempt' &&
        each.args?.objective === firstGap?.id,
    ),
    { expectedLabels: { idA, idB }, gapObjective: firstGap?.id, dayTwoPlan: dayTwoPlan?.topic },
  )
  check(
    'it recorded the activity it chose, and why',
    seen.some(
      (each) =>
        each.day === 'day2' && each.args?.kind === 'move' && each.args?.objective === firstGap?.id,
    ),
    reread?.moves,
  )
  check('it recorded the new answer', (reread?.attempts ?? 0) >= 2, {
    attempts: reread?.attempts,
    gap: reread?.gap?.status,
  })
  check(
    'the corrected answer did not become confirmed by itself',
    reread?.confirmation !== 'person' && reread?.confirmation !== 'delegated',
    reread?.confirmation,
  )
  const readingA = afterPerson.objectives.find((each) => each.confirmation === 'person')
  check('the part the person confirmed reads as theirs', readingA !== undefined, readingA?.label)
  check('the page gets no words of a turn', !JSON.stringify(final).includes(WRONG))
  check(
    'no tool that decides was called',
    !seen.some((each) => /decide|accept|confirm/.test(each.tool ?? '')),
  )

  if (!values['skip-baselines']) {
    currentDay = 'p0'
    await conversation(
      'p0',
      [
        TEACHING,
        '这是一次新的学习。你没有和这个人说过话，也没有之前的聊天记录。决定今天做什么，然后问第一个问题。',
      ].join('\n\n'),
      [],
      false,
    )
    currentDay = 'p1'
    const history = [
      `助手问了涨潮条件。学习者：${RIGHT}`,
      `助手问了中潮层崩溃后怎么重放。学习者：${WRONG}`,
      `学习者：${POINT_A}这部分我觉得我懂了。${POINT_B}我还没把握，今天先到这里。`,
    ].join('\n')
    await conversation(
      'p1',
      [
        TEACHING,
        `这是上次的聊天记录：\n<history>\n${history}\n</history>`,
        '这是一次新的学习。决定今天做什么，然后问第一个问题。结束时用一段文字列出：这个人已确认理解了什么、你判断他还有什么缺口。',
      ].join('\n\n'),
      [CORRECTED, '嗯，我现在明白了。今天到这里。'],
      false,
    )
  }
} finally {
  report.estimatedCostUsd = spentSoFar()
  report.toolsDay1 = tools('day1')
  report.toolsDay2 = tools('day2')
  report.refusals = answers
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  if (!values.hold) {
    await service.close()
    proxy.close()
  }
}
process.stdout.write(`${JSON.stringify(report.checks, null, 2)}\nestimated cost ${spentSoFar()}\n`)
if (values.hold) {
  process.stdout.write(`page: ${service.workspaceUrl}\nservice held; stop this process to end.\n`)
} else {
  process.exit(0)
}
