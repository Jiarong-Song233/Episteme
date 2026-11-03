#!/usr/bin/env node
/**
 * One reproducible evaluation round: fixed fictional material, fixed questions, the same model behind every system.
 *
 * The material is invented, so a model cannot answer from what it already knows. A system is an object with
 * `prepare(files)`, `ask(question)` returning `{ text, status?, citations: [{ file, quote }] }`, and `close()`; adding a
 * comparison system means adding one more of those to SYSTEMS, and nothing about the scoring changes.
 *
 *   pnpm exec tsc -b && node scripts/evaluate.mjs --out result.json
 *
 * Needs EPISTEME_MODEL_BASE_URL and EPISTEME_MODEL_NAME, and refuses to run on the simulated model unless --simulated is
 * passed, because a score from canned answers would read like a result. Calls are capped per system by --max-calls.
 * Failures on the question set are counted, never retried: a retry would hide what a person would have seen. The journey
 * retries a failed step once, as a person pressing the button would, and still counts the failure.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { addPerson, addToken, startService } from '../apps/service/dist/index.js'
import {
  citationsOf,
  MaterialStore,
  modelFromEnvironment,
  relevant,
  SimulatedModel,
  workbenchProfile,
} from '../apps/workbench/dist/index.js'
import { openWebUI } from './evaluate-openwebui.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    questions: { type: 'string', default: 'questions.json' },
    repeats: { type: 'string', default: '3' },
    systems: { type: 'string', default: 'episteme,model-only,paste-all' },
    'no-journey': { type: 'boolean', default: false },
    'retrieval-only': { type: 'boolean', default: false },
    'max-calls': { type: 'string', default: '300' },
    simulated: { type: 'boolean', default: false },
    'openwebui-home': { type: 'string' },
    rescore: { type: 'string' },
  },
})

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'docs', 'research', 'evaluation')
const QUESTIONS = JSON.parse(readFileSync(join(ROOT, values.questions), 'utf8'))
const FILES = readdirSync(join(ROOT, 'material'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(ROOT, 'material', name), 'utf8') }))

/** Saying the material does not cover it, in the words a model actually uses. Raw answers are kept, so this can be re-read. */
const ABSTAINS =
  /没有|未提|未说明|未给出|未涉及|不包含|无法|不知道|不清楚|找不到|没提|不足|未知|不确定/

const stem = (name) => name.replace(/\.[a-z]+$/i, '')

/** The same rules for every system, on nothing but what a person would see. */
function score(question, answer) {
  if (question.gold === null) {
    return {
      abstained: ABSTAINS.test(answer.text),
      citedAnything: answer.citations.length > 0,
      // "The material does not cover this, but Paris" passes the wording check and is still an answer from elsewhere.
      answeredAnyway: question.known !== undefined && new RegExp(question.known).test(answer.text),
    }
  }
  const gold = new RegExp(question.gold)
  const onSource = answer.citations.filter((c) => stem(c.file) === stem(question.source))
  return {
    correct: gold.test(answer.text),
    falselyAbstained: !gold.test(answer.text) && ABSTAINS.test(answer.text),
    citedGold: onSource.some((c) => gold.test(c.quote)),
    citations: answer.citations.length,
    citationsOnSource: onSource.length,
    quoteChars: answer.citations.map((c) => c.quote.length),
    // The one sentence a reader is pointed at. A system that points at nothing has none to check.
    pointedAtGold: (answer.evidence ?? []).some((sentence) => gold.test(sentence)),
    pointedChars: (answer.evidence ?? []).map((sentence) => sentence.length),
  }
}

function percentile(values_, share) {
  if (values_.length === 0) return null
  const sorted = [...values_].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]
}

const share = (hits, total) => (total === 0 ? null : Number((hits / total).toFixed(3)))

function summarize(runs) {
  const of = (kinds) => runs.filter((run) => kinds.includes(run.kind) && run.error === undefined)
  const answerable = (kinds) => {
    const rows = of(kinds)
    return {
      n: rows.length,
      correct: share(rows.filter((r) => r.score.correct).length, rows.length),
      correctAndCited: share(
        rows.filter((r) => r.score.correct && r.score.citedGold).length,
        rows.length,
      ),
      falselyAbstained: share(rows.filter((r) => r.score.falselyAbstained).length, rows.length),
      correctAndPointed: share(
        rows.filter((r) => r.score.correct && r.score.pointedAtGold).length,
        rows.length,
      ),
    }
  }
  const absent = of(['absent'])
  const cited = of(['direct', 'paraphrase', 'cross', 'heldout'])
  const citations = cited.reduce((sum, r) => sum + r.score.citations, 0)
  return {
    direct: answerable(['direct']),
    paraphrase: answerable(['paraphrase']),
    cross: answerable(['cross']),
    heldout: answerable(['heldout']),
    offtopic: {
      n: of(['offtopic']).length,
      abstained: share(
        of(['offtopic']).filter((r) => r.score.abstained).length,
        of(['offtopic']).length,
      ),
      answeredAnyway: share(
        of(['offtopic']).filter((r) => r.score.answeredAnyway).length,
        of(['offtopic']).length,
      ),
    },
    absent: {
      n: absent.length,
      abstained: share(absent.filter((r) => r.score.abstained).length, absent.length),
      citedAnything: share(absent.filter((r) => r.score.citedAnything).length, absent.length),
    },
    citationPrecision: share(
      cited.reduce((sum, r) => sum + r.score.citationsOnSource, 0),
      citations,
    ),
    // A citation that hands back a whole page is technically true and hard to check, so its size is part of its quality.
    medianQuoteChars: percentile(
      cited.flatMap((r) => r.score.quoteChars),
      0.5,
    ),
    medianPointedChars: percentile(
      cited.flatMap((r) => r.score.pointedChars),
      0.5,
    ),
    errors: runs.filter((run) => run.error !== undefined).length,
    latencyMs: {
      p50: percentile(
        runs.map((r) => r.ms),
        0.5,
      ),
      p95: percentile(
        runs.map((r) => r.ms),
        0.95,
      ),
    },
  }
}

/** Counts what a system spends, whichever route it takes to the model. */
function metered() {
  const inner = values.simulated ? new SimulatedModel() : modelFromEnvironment(process.env)
  if (inner.simulated && !values.simulated) {
    throw new Error('no model configured: set EPISTEME_MODEL_BASE_URL and EPISTEME_MODEL_NAME')
  }
  const limit = Number(values['max-calls'])
  const spent = { calls: 0, tokens: 0, failures: 0 }
  return {
    spent,
    client: {
      name: inner.name,
      simulated: inner.simulated,
      async complete(messages) {
        if (spent.calls >= limit) throw new Error(`more than ${limit} calls`)
        spent.calls += 1
        try {
          const reply = await inner.complete(messages)
          spent.tokens += reply.tokens ?? 0
          return reply
        } catch (error) {
          spent.failures += 1
          throw error
        }
      },
    },
  }
}

/** One workbench with two people, the way it runs when shared. */
async function openWorkbench(client) {
  const directory = mkdtempSync(join(tmpdir(), 'episteme-evaluate-'))
  const users = join(directory, 'users.json')
  const tokens = {}
  for (const name of ['lin', 'wei']) {
    tokens[name] = await addToken(users, await addPerson(users, name), 'human', 'workbench')
  }
  const start = () =>
    startService({
      port: 0,
      graph: join(directory, 'graph.db'),
      profile: workbenchProfile({ model: client }),
      mode: 'shared',
      users,
      publicOrigin: 'https://workbench.example.edu',
      sharing: true,
    })
  const startedAt = performance.now()
  const bench = {
    service: await start(),
    startupMs: Math.round(performance.now() - startedAt),
    requests: 0,
    tokens,
    async restart() {
      await bench.service.close()
      bench.service = await start()
    },
    async close() {
      await bench.service.close()
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
    /** Throws on a refusal, so a step that did not happen cannot be counted as done. */
    async call(path, body, who = 'lin') {
      bench.requests += 1
      const response = await fetch(`${bench.service.apiUrl}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`)
      return JSON.parse(text)
    },
    scene: (path, body, who) => bench.call(`/scene/workbench${path}`, body, who),
    async space(name, who, files = FILES) {
      const { space } = await bench.scene('/spaces', { name }, who)
      for (const file of files) {
        await bench.scene(
          '/materials',
          {
            space: space.id,
            fileName: file.name,
            contentBase64: Buffer.from(file.text).toString('base64'),
          },
          who,
        )
      }
      return space.id
    },
  }
  return bench
}

const SYSTEMS = {
  /** The whole product: retrieval, citation checking and abstention, over its own HTTP API. */
  episteme: async (client) => {
    const bench = await openWorkbench(client)
    let space
    return {
      describe: 'Episteme workbench，关键词检索，经它自己的 HTTP 接口',
      startupMs: bench.startupMs,
      async prepare() {
        space = await bench.space('评测')
      },
      async ask(question) {
        const reply = await bench.scene('/ask', { space, question })
        if (reply.failure !== undefined)
          throw new Error(`${reply.failure.code}: ${reply.failure.message}`)
        return {
          // Saying nothing is how a refusal is stored; these are the words the page shows for it (Turns.tsx).
          text:
            reply.answer.status === 'insufficient_evidence'
              ? '材料里没有足够的依据讲这一点。'
              : reply.answer.segments.map((segment) => segment.text).join(''),
          status: reply.answer.status,
          invalidCitations: reply.answer.invalidCitations,
          citations: reply.answer.citations.map((c) => ({ file: c.title, quote: c.quote })),
          evidence: reply.answer.segments.flatMap((segment) =>
            (segment.evidence ?? []).map(({ n, start, end }) => {
              const title = reply.answer.citations.find((c) => c.n === n)?.title
              return FILES.find((file) => file.name === title)?.text.slice(start, end) ?? ''
            }),
          ),
        }
      },
      close: () => bench.close(),
    }
  },
  /** The floor: the same model with nothing to read. It should know none of this. */
  'model-only': async (client) => ({
    describe: '同一模型，不给材料',
    async prepare() {},
    async ask(question) {
      const { text } = await client.complete([
        { role: 'system', content: '用中文简短回答。不知道就直接说不知道，不要编造。' },
        { role: 'user', content: question },
      ])
      return { text, citations: [] }
    },
    async close() {},
  }),
  /**
   * What a person gets by pasting everything into a chat. It works only while the material fits in one prompt, which
   * this small set does. Quotes are the model's own claim, so one that is not in the file is not counted as a citation.
   */
  'paste-all': async (client) => {
    let context = ''
    return {
      describe: '同一模型，把全部材料贴进提示词，无检索',
      async prepare(files) {
        context = files.map((file) => `【文件：${file.name}】\n${file.text}`).join('\n\n')
      },
      async ask(question) {
        const { text } = await client.complete([
          {
            role: 'system',
            content:
              '只依据下面的材料用中文简短回答。材料里没有就说材料里没有。回答的最后一行输出 JSON：' +
              '{"citations":[{"file":"文件名","quote":"原文句子"}]}，没有可引用的内容就输出空数组。\n\n' +
              context,
          },
          { role: 'user', content: question },
        ])
        // Models often fence the JSON, so it is looked for rather than expected on the last line.
        const line = /\{\s*"citations"[\s\S]*\}/.exec(text)?.[0] ?? ''
        let claimed = []
        try {
          claimed = JSON.parse(line).citations ?? []
        } catch {
          // No parsable citation line is a result, not a failure: the answer simply cites nothing.
        }
        const citations = claimed.filter((c) =>
          FILES.some(
            (file) => stem(file.name) === stem(String(c.file)) && file.text.includes(c.quote),
          ),
        )
        return {
          text: line === '' ? text : text.replace(line, ''),
          citations,
          evidence: citations.map((c) => c.quote),
        }
      },
      async close() {},
    }
  },
  /** A mature product, run rather than read about, as a person installs it. */
  'open-webui': (client, spent) =>
    openWebUISystem(client, spent, 'Open WebUI 默认配置：英文嵌入模型，向量检索', {}),
  /** The first thing a person with Chinese material would change, so the default is not the only thing judged. */
  'open-webui-zh': (client, spent) =>
    openWebUISystem(client, spent, 'Open WebUI，换成多语言嵌入模型', {
      RAG_EMBEDDING_MODEL: MULTILINGUAL_EMBEDDING,
    }),
  /** As above, with its keyword and vector hybrid switched on, which is the nearest it comes to what Episteme does. */
  'open-webui-zh-hybrid': (client, spent) =>
    openWebUISystem(client, spent, 'Open WebUI，多语言嵌入模型加混合检索', {
      RAG_EMBEDDING_MODEL: MULTILINGUAL_EMBEDDING,
      ENABLE_RAG_HYBRID_SEARCH: 'True',
    }),
  /** Episteme hands the model up to six passages and Open WebUI three by default, so this removes that difference. */
  'open-webui-zh-k6': (client, spent) =>
    openWebUISystem(client, spent, 'Open WebUI，多语言嵌入模型，取 6 段', {
      RAG_EMBEDDING_MODEL: MULTILINGUAL_EMBEDDING,
      RAG_TOP_K: '6',
    }),
}

const MULTILINGUAL_EMBEDDING = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'

function openWebUISystem(client, spent, describe, settings) {
  const home = values['openwebui-home']
  if (home === undefined) throw new Error('pass --openwebui-home: round-3.md shows the install')
  return openWebUI({
    venv: join(home, 'venv'),
    home,
    settings,
    describe,
    model: client.name,
    limit: Number(values['max-calls']),
    spent,
  })
}

async function runQuestions(name) {
  const { client, spent } = metered()
  const system = await SYSTEMS[name](client, spent)
  await system.prepare(FILES)
  const runs = []
  for (let repeat = 0; repeat < Number(values.repeats); repeat += 1) {
    for (const question of QUESTIONS.questions) {
      const startedAt = performance.now()
      const row = { id: question.id, kind: question.kind, repeat }
      try {
        const answer = await system.ask(question.question)
        Object.assign(row, { answer, score: score(question, answer) })
      } catch (error) {
        row.error = String(error.message ?? error)
      }
      row.ms = Math.round(performance.now() - startedAt)
      runs.push(row)
      process.stderr.write(`${name} ${repeat} ${question.id} ${row.error ?? 'ok'}\n`)
    }
  }
  await system.close()
  return {
    system: name,
    describe: system.describe,
    ...(system.startupMs === undefined ? {} : { startupMs: system.startupMs }),
    model: client.name,
    spent,
    summary: summarize(runs),
    runs,
  }
}

/**
 * The PRD's task list on Episteme alone: there is nothing to compare it with until a second system runs. A task counts
 * as done only if the state it should leave behind is really there, read back separately from the step that made it.
 */
async function runJourney() {
  const { client, spent } = metered()
  const bench = await openWorkbench(client)
  const tasks = []
  const task = async (name, work) => {
    const before = { requests: bench.requests, calls: spent.calls, failures: spent.failures }
    const startedAt = performance.now()
    const row = { task: name }
    try {
      row.detail = await work()
      row.completed = true
    } catch (error) {
      row.completed = false
      row.error = String(error.message ?? error)
    }
    tasks.push({
      ...row,
      requests: bench.requests - before.requests,
      modelCalls: spent.calls - before.calls,
      modelFailures: spent.failures - before.failures,
      ms: Math.round(performance.now() - startedAt),
    })
    process.stderr.write(`journey ${name} ${row.completed ? 'ok' : row.error}\n`)
  }
  const must = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  const DIALOGS = {
    retell: '我的理解是：缓存分层，突发流量只影响最浅的一层。',
    probe: '例子：夜里对账扫全库时，它不起作用，因为负载是长期的。',
    reflect: '原来以为容量是定时调整的，其实由观察到的情况决定。',
  }

  const runPlan = async (plan) => {
    const questions = []
    const failures = []
    const skippedAfterFailure = []
    const act = (body) => bench.scene('/plans/act', { plan: plan.id, ...body })
    let request = { action: 'begin' }
    let reply = await act(request)
    let retried = false
    for (let guard = 0; reply.plan.status !== 'done' && guard < 80; guard += 1) {
      const active = reply.plan.steps.find((step) => step.status === 'active')
      if (reply.failure !== undefined) {
        failures.push(`${active?.block ?? 'none'}:${reply.failure.code}:${reply.failure.message}`)
        if (retried) {
          skippedAfterFailure.push(active?.block ?? 'none')
          request = { action: 'skip' }
        } else {
          request = { ...request, retry: true }
        }
        retried = !retried
      } else if (reply.question !== undefined) {
        // The harness is no learner: it answers the same way each time, so this measures the flow, not learning.
        questions.push(reply.question)
        request = { action: 'answer', text: reply.question.options === undefined ? '不确定' : '0' }
        retried = false
      } else if (active !== undefined && DIALOGS[active.block] && active.rounds === 0) {
        request = { action: 'reply', text: DIALOGS[active.block] }
        retried = false
      } else {
        request = { action: 'next' }
        retried = false
      }
      reply = await act(request)
    }
    must(reply.plan.status === 'done', `plan stopped at ${reply.plan.status}`)
    return {
      steps: reply.plan.steps.map((s) => `${s.block}:${s.status}`),
      questions,
      failures,
      skippedAfterFailure,
    }
  }

  let space
  await task('上传', async () => {
    space = await bench.space('旅程')
    const { materials } = await bench.scene(`/materials?space=${space}`)
    must(materials.length === FILES.length, `${materials.length} materials`)
    const again = await bench.scene('/materials', {
      space,
      fileName: FILES[0].name,
      contentBase64: Buffer.from(FILES[0].text).toString('base64'),
    })
    must(again.duplicate === true, 'the same file was not recognised')
    return { materials: materials.length, duplicateNoticed: true }
  })

  let asked
  await task('引用问答', async () => {
    asked = await bench.scene('/ask', { space, question: '浅潮层的默认容量是多少？' })
    must(asked.failure === undefined, asked.failure?.code)
    must(asked.answer.status === 'answered', asked.answer.status)
    must(asked.answer.citations.length > 0, 'no citation')
    return { citations: asked.answer.citations.length }
  })

  let plan
  await task('计划', async () => {
    plan = (
      await bench.scene('/plans', {
        space,
        topic: '潮汐缓存协议',
        minutes: 30,
        workflow: 'speedrun',
      })
    ).plan
    const read = await bench.scene(`/plan?id=${plan.id}`)
    must(read.plan.steps.length > 0, 'no steps')
    return { origin: plan.origin, focuses: plan.steps.map((s) => s.focus) }
  })
  await task('速通', async () => {
    must(plan !== undefined, 'no plan')
    return runPlan(plan)
  })
  await task('深学与练习', async () => {
    const deep = (
      await bench.scene('/plans', { space, topic: '珊瑚调度器', minutes: 30, workflow: 'deep' })
    ).plan
    const done = await runPlan(deep)
    must(done.questions.length > 0, 'no practice happened')
    return done
  })

  let mine
  await task('存取理解', async () => {
    const offered = await bench.scene('/candidates', {
      space,
      thread: asked.thread,
      reply: asked.reply,
    })
    for (const suggestion of offered.suggestions) {
      await bench.call('/suggestions/decide', { id: suggestion.id, action: 'accept' })
    }
    const words = '浅潮层的容量在涨潮时翻倍'
    const { thread } = await bench.call('/threads', { title: '笔记', scope: `workbench:${space}` })
    const { turn } = await bench.call(`/threads/${thread.id}/turns`, {
      speaker: 'learner',
      text: words,
    })
    const own = await bench.scene('/candidates/turn', { space, thread: thread.id, turn: turn.id })
    for (const suggestion of own.suggestions) {
      await bench.call('/suggestions/decide', { id: suggestion.id, action: 'accept' })
    }
    const { nodes } = await bench.scene(`/understanding?space=${space}`)
    mine = nodes.find((node) => node.label === words)
    must(mine !== undefined, 'what the person said was not kept')
    return { fromAnswer: offered.suggestions.length, held: nodes.map((node) => node.label) }
  })

  await task('修正', async () => {
    const better = '命中率连续偏低时，浅潮层容量才翻倍'
    const revised = await bench.scene('/understanding/revise', {
      space,
      node: mine.nodeId,
      label: better,
      reason: '不是所有涨潮都因为容量',
    })
    for (const suggestion of revised.suggestions) {
      await bench.call('/suggestions/decide', { id: suggestion.id, action: 'accept' })
    }
    const { nodes } = await bench.scene(`/understanding?space=${space}`)
    const now = nodes.find((node) => node.label === better)
    must(now !== undefined, 'the revision did not land')
    const { trail } = await bench.scene(`/understanding/trail?space=${space}&node=${now.nodeId}`)
    must(JSON.stringify(trail).includes(mine.label), 'the earlier version is gone from the trail')
    mine = now
    return { trailEntries: trail.length }
  })

  await task('跨会话复用', async () => {
    await bench.restart()
    const held = await bench.scene(`/understanding?space=${space}`)
    must(
      held.nodes.some((node) => node.nodeId === mine.nodeId),
      'gone after a restart',
    )
    const question = '浅潮层容量什么时候翻倍？'
    // No thread: a new conversation, after a restart, with only the graph to remember by.
    const reply = await bench.scene('/ask', { space, question })
    must(reply.failure === undefined, reply.failure?.code)
    const recalled = JSON.stringify(reply.answer.recalled ?? null)
    must(recalled.includes(mine.label), `not recalled: ${recalled.slice(0, 200)}`)
    // Recall stays inside a space by design; a person with two subjects should know that, so the report says it.
    const other = await bench.space(
      '另一个主题',
      'lin',
      FILES.filter((f) => f.name.startsWith('灯塔')),
    )
    const elsewhere = await bench.scene('/ask', { space: other, question })
    return {
      recalled: reply.answer.recalled,
      status: reply.answer.status,
      recalledInAnotherSpace: (elsewhere.answer?.recalled ?? []).length,
    }
  })

  await task('跨身份引用', async () => {
    const { publication } = await bench.call('/publications', { root: mine.nodeId })
    const wei = await bench.space('魏的空间', 'wei', [])
    await bench.call(
      `/publications/${publication.id}/adopt`,
      { node: mine.nodeId, dimensions: { confidence: 'medium' } },
      'wei',
    )
    await bench.scene(
      '/sharing/cite',
      { space: wei, publication: publication.id, node: mine.nodeId },
      'wei',
    )
    const answer = '翻倍只是一种做法，也可以按比例增长'
    const responded = await bench.scene(
      '/sharing/respond',
      {
        space: wei,
        publication: publication.id,
        node: mine.nodeId,
        label: answer,
        relation: 'forks',
        reason: '反驳',
      },
      'wei',
    )
    for (const suggestion of responded.suggestions) {
      await bench.call('/suggestions/decide', { id: suggestion.id, action: 'accept' }, 'wei')
    }
    const { nodes } = await bench.scene(`/understanding?space=${wei}`, undefined, 'wei')
    const fork = nodes.find((node) => node.label === answer)
    must(fork !== undefined, 'the answer was not held')
    const { steps } = await bench.scene(`/sharing/lineage?node=${fork.nodeId}`, undefined, 'wei')
    must(steps.length >= 2, 'the fork does not trace back')
    const lins = await bench.scene(`/understanding?space=${space}`)
    must(
      lins.nodes.every((node) => node.label !== answer),
      'it leaked into the original author',
    )
    return { lineage: steps.length }
  })

  await bench.close()
  return { startupMs: bench.startupMs, spent, tasks }
}

/**
 * Where a wrong answer starts, with no model involved: was the right passage found, did it survive the relevance gate,
 * and is the answer inside the part of it a citation shows? Answer scores alone cannot tell these apart.
 */
async function runRetrieval() {
  let lines = []
  const store = await MaterialStore.open({
    read: () => Promise.resolve(lines),
    append: (body) => {
      lines = [...lines, body]
      return Promise.resolve()
    },
    replace: (bodies) => {
      lines = bodies
      return Promise.resolve()
    },
  })
  for (const file of FILES) {
    await store.add({
      owner: 'o',
      space: 's',
      title: file.name,
      parsed: { text: file.text },
      at: 0,
    })
  }
  return QUESTIONS.questions.map((question) => {
    const hits = store.search('o', 's', question.question)
    const passed = relevant(hits)
    const row = {
      id: question.id,
      kind: question.kind,
      hits: hits.length,
      bestCoverage: Number(Math.max(0, ...hits.map((hit) => hit.coverage)).toFixed(2)),
      passedGate: passed.length,
    }
    if (question.gold === null) return row
    const gold = new RegExp(question.gold)
    const holds = (hit) =>
      stem(hit.material.title) === stem(question.source) && gold.test(hit.chunk.text)
    const rank = hits.findIndex(holds)
    const kept = passed.findIndex(holds)
    return {
      ...row,
      goldRank: rank === -1 ? null : rank + 1,
      goldPassedGate: kept !== -1,
      goldVisibleInQuote: kept !== -1 && gold.test(citationsOf(passed)[kept]?.quote ?? ''),
    }
  })
}

/** Applies today's scoring to reports already on disk, so a stricter rule costs no model calls and hides nothing. */
function rescore(paths) {
  const byId = new Map(QUESTIONS.questions.map((question) => [question.id, question]))
  const reports = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')))
  const results = reports.flatMap((report) => report.results)
  for (const result of results) {
    for (const run of result.runs) {
      if (run.answer !== undefined) run.score = score(byId.get(run.id), run.answer)
    }
    result.summary = summarize(result.runs)
  }
  return {
    ...reports[0],
    round: QUESTIONS.version,
    questionSet: QUESTIONS.version,
    finishedAt: reports.at(-1).finishedAt,
    rescoredFrom: paths.length,
    results,
  }
}

if (values.rescore !== undefined) {
  const report = rescore(values.rescore.split(','))
  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`)
  for (const result of report.results) {
    process.stdout.write(`${JSON.stringify({ system: result.system, ...result.summary })}\n`)
  }
  process.exit(0)
}

if (values['retrieval-only']) {
  process.stdout.write(`${(await runRetrieval()).map((row) => JSON.stringify(row)).join('\n')}\n`)
  process.exit(0)
}

const startedAt = new Date().toISOString()
const names = values.systems.split(',').filter((name) => name !== '')
const results = []
for (const name of names) results.push(await runQuestions(name))
const journey = values['no-journey'] ? null : await runJourney()
const retrieval = await runRetrieval()

const report = {
  round: QUESTIONS.version,
  startedAt,
  finishedAt: new Date().toISOString(),
  simulated: values.simulated,
  questionSet: QUESTIONS.version,
  repeats: Number(values.repeats),
  material: FILES.map((file) => file.name),
  node: process.version,
  results,
  journey,
  retrieval,
}
if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(
  `${JSON.stringify(
    {
      simulated: report.simulated,
      systems: results.map((r) => ({ system: r.system, spent: r.spent, ...r.summary })),
      journey: journey?.tasks.map((t) => ({
        task: t.task,
        completed: t.completed,
        requests: t.requests,
        modelCalls: t.modelCalls,
        modelFailures: t.modelFailures,
        ms: t.ms,
        ...(t.error === undefined ? {} : { error: t.error }),
      })),
    },
    null,
    2,
  )}\n`,
)
