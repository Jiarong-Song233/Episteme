#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CognitiveSession } from '../packages/application/dist/index.js'
import {
  defaultProfile,
  embeddingsFromEnvironment,
  startService,
} from '../apps/service/dist/index.js'

const CORPUS = [
  {
    key: 'dev-transaction',
    scenario: 'dev',
    label:
      'SQLite transactions make a batch of writes atomic: commit all changes together or roll them all back.',
  },
  {
    key: 'dev-retry',
    scenario: 'dev',
    label:
      'Exponential backoff with random jitter spreads retries after a transient connection failure.',
  },
  {
    key: 'dev-negative',
    scenario: 'dev',
    label: 'SQLite transactions are unnecessary for atomic writes; save each change independently.',
  },
  {
    key: 'dev-noise',
    scenario: 'dev',
    label: 'CSS grid arranges dashboard cards into responsive columns.',
  },
  {
    key: 'learn-order',
    scenario: 'learn',
    label:
      'Self-attention alone cannot encode token order; positional encoding supplies sequence position.',
  },
  {
    key: 'learn-spacing',
    scenario: 'learn',
    label:
      'Spaced repetition revisits material over increasing intervals to improve long-term retention.',
  },
  {
    key: 'learn-negative',
    scenario: 'learn',
    label:
      'Self-attention alone encodes token order without positional encoding or sequence position.',
  },
  {
    key: 'learn-noise',
    scenario: 'learn',
    label: 'Chlorophyll absorbs sunlight during photosynthesis in green leaves.',
  },
  {
    key: 'discussion-evidence',
    scenario: 'discussion',
    label:
      'A majority vote records agreement, but a scientific claim still needs independent evidence.',
  },
  {
    key: 'discussion-dissent',
    scenario: 'discussion',
    label:
      'Preserve dissenting arguments with their authors and sources even after the group reaches consensus.',
  },
  {
    key: 'discussion-negative',
    scenario: 'discussion',
    label: 'A majority vote proves a scientific claim; agreement replaces independent evidence.',
  },
  {
    key: 'discussion-noise',
    scenario: 'discussion',
    label: 'The weekly meeting starts on Tuesday afternoon in room seven.',
  },
]

const CASES = [
  {
    id: 'dev-direct-1',
    scenario: 'dev',
    kind: 'direct',
    question: 'SQLite transactions roll back atomic writes',
    gold: 'dev-transaction',
  },
  {
    id: 'dev-paraphrase-1',
    scenario: 'dev',
    kind: 'paraphrase',
    question: 'How can several database updates succeed or fail as one indivisible operation?',
    gold: 'dev-transaction',
  },
  {
    id: 'dev-cross-1',
    scenario: 'dev',
    kind: 'cross-language',
    question: '怎样让一批数据库更新要么全部成功要么全部撤销？',
    gold: 'dev-transaction',
  },
  {
    id: 'dev-direct-2',
    scenario: 'dev',
    kind: 'direct',
    question: 'Exponential backoff random jitter retries',
    gold: 'dev-retry',
  },
  {
    id: 'dev-paraphrase-2',
    scenario: 'dev',
    kind: 'paraphrase',
    question: 'What prevents many disconnected clients from reconnecting simultaneously?',
    gold: 'dev-retry',
  },
  {
    id: 'dev-cross-2',
    scenario: 'dev',
    kind: 'cross-language',
    question: '网络短暂故障后，怎样避免所有客户端同时重试？',
    gold: 'dev-retry',
  },
  {
    id: 'learn-direct-1',
    scenario: 'learn',
    kind: 'direct',
    question: 'Self-attention cannot encode token order positional encoding',
    gold: 'learn-order',
  },
  {
    id: 'learn-paraphrase-1',
    scenario: 'learn',
    kind: 'paraphrase',
    question: 'How does a transformer know which word comes first?',
    gold: 'learn-order',
  },
  {
    id: 'learn-cross-1',
    scenario: 'learn',
    kind: 'cross-language',
    question: '为什么注意力模型需要额外知道词语的先后顺序？',
    gold: 'learn-order',
  },
  {
    id: 'learn-direct-2',
    scenario: 'learn',
    kind: 'direct',
    question: 'Spaced repetition increasing intervals retention',
    gold: 'learn-spacing',
  },
  {
    id: 'learn-paraphrase-2',
    scenario: 'learn',
    kind: 'paraphrase',
    question: 'How can I remember studied facts months later by scheduling reviews farther apart?',
    gold: 'learn-spacing',
  },
  {
    id: 'learn-cross-2',
    scenario: 'learn',
    kind: 'cross-language',
    question: '如何安排越来越疏的复习来保持长期记忆？',
    gold: 'learn-spacing',
  },
  {
    id: 'discussion-direct-1',
    scenario: 'discussion',
    kind: 'direct',
    question: 'majority vote scientific claim still needs evidence',
    gold: 'discussion-evidence',
  },
  {
    id: 'discussion-paraphrase-1',
    scenario: 'discussion',
    kind: 'paraphrase',
    question: 'Does everybody saying yes establish that an assertion is true?',
    gold: 'discussion-evidence',
  },
  {
    id: 'discussion-cross-1',
    scenario: 'discussion',
    kind: 'cross-language',
    question: '多数人赞成某个科学结论，是否就能代替独立证据？',
    gold: 'discussion-evidence',
  },
  {
    id: 'discussion-direct-2',
    scenario: 'discussion',
    kind: 'direct',
    question: 'Preserve dissenting arguments authors sources consensus',
    gold: 'discussion-dissent',
  },
  {
    id: 'discussion-paraphrase-2',
    scenario: 'discussion',
    kind: 'paraphrase',
    question: 'Should minority objections remain attributable once everyone else has agreed?',
    gold: 'discussion-dissent',
  },
  {
    id: 'discussion-cross-2',
    scenario: 'discussion',
    kind: 'cross-language',
    question: '集体达成共识后，少数人的反对意见及其出处应该保留吗？',
    gold: 'discussion-dissent',
  },
  {
    id: 'dev-absent',
    scenario: 'dev',
    kind: 'absent',
    question: 'Kubernetes ingress certificate renewal',
    gold: null,
  },
  {
    id: 'learn-absent',
    scenario: 'learn',
    kind: 'absent',
    question: 'Medieval pottery kiln temperatures',
    gold: null,
  },
  {
    id: 'discussion-absent',
    scenario: 'discussion',
    kind: 'absent',
    question: '葡萄牙首都的人口是多少？',
    gold: null,
  },
]

const WEIGHTS = { semantic: 0, lexical: 1, graph: 0, cognitive: 0, recency: 0 }
const { values } = parseArgs({
  options: {
    semantic: { type: 'boolean', default: false },
    k: { type: 'string', default: '3' },
    help: { type: 'boolean', default: false },
  },
})
const k = Number(values.k)
if (!Number.isInteger(k) || k < 1 || k > 8) {
  console.error('--k must be an integer between 1 and the application recall limit, 8.')
  process.exitCode = 1
} else if (values.help) {
  console.log('Usage: node scripts/evaluate-cli-recall.mjs [--k 1..8] [--semantic]')
  console.log('Offline by default. --semantic uses EPISTEME_EMBEDDINGS_* on loopback only.')
} else {
  try {
    console.log(JSON.stringify(await evaluate(), null, 2))
  } catch {
    // Provider errors can contain response bodies, endpoint credentials or bearer tokens.
    console.error(
      'Evaluation failed; no result is claimed. Check local dist files and D:\\Temp access. Error details are suppressed to protect credentials.',
    )
    process.exitCode = 1
  }
}

function loopback(url) {
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  )
}

function semanticSettings() {
  if (!values.semantic) return { status: 'unverified', reason: 'not_requested' }
  let settings
  try {
    settings = embeddingsFromEnvironment()
  } catch {
    return { status: 'unverified', reason: 'invalid_configuration' }
  }
  if (!settings) return { status: 'unverified', reason: 'no_embedding_service_configured' }
  let url
  try {
    url = new URL(settings.baseUrl)
  } catch {
    return { status: 'unverified', reason: 'invalid_endpoint' }
  }
  if (!loopback(url)) return { status: 'unverified', reason: 'only_loopback_endpoints_allowed' }
  if (settings.timeoutMs > 30_000)
    return { status: 'unverified', reason: 'timeout_exceeds_30000ms' }
  return { settings }
}

function summarize(rows) {
  const positive = rows.filter((row) => row.gold !== null)
  const absent = rows.filter((row) => row.gold === null)
  const valid = positive.filter((row) => row.valid)
  const validAbsent = absent.filter((row) => row.valid)
  return {
    positiveQueries: positive.length,
    evaluatedPositiveQueries: valid.length,
    top1Hits: valid.filter((row) => row.top1Hit).length,
    topkHits: valid.filter((row) => row.topkHit).length,
    top1Rate: valid.length ? valid.filter((row) => row.top1Hit).length / valid.length : null,
    topkRate: valid.length ? valid.filter((row) => row.topkHit).length / valid.length : null,
    absentQueries: absent.length,
    evaluatedAbsentQueries: validAbsent.length,
    absentEmpty: validAbsent.filter((row) => row.returned === 0).length,
  }
}

async function evaluate() {
  const configured = semanticSettings()
  const originalFetch = globalThis.fetch
  const cancelled = new AbortController()
  const stop = () => cancelled.abort()
  const closeChecks = []
  const counters = { serviceRequests: 0, embeddingRequests: 0 }
  let directory
  let service
  let session
  let stage = 'setup'
  let result
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  globalThis.fetch = (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    assert(loopback(url), 'Only loopback requests are allowed')
    if (service && url.origin === service.url && url.pathname.startsWith('/api/v1/'))
      counters.serviceRequests += 1
    else counters.embeddingRequests += 1
    return originalFetch(input, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.any([cancelled.signal, options.signal ?? AbortSignal.timeout(30_000)]),
    })
  }
  try {
    directory = await mkdtemp(join('D:\\Temp', 'episteme-cli-recall-'))
    const graph = join(directory, 'graph.db')
    const profile = defaultProfile()
    service = await startService({ graph, port: 0, host: '127.0.0.1', profile, embeddings: false })
    const keys = new Map()
    async function post(path, body) {
      cancelled.signal.throwIfAborted()
      const response = await fetch(`${service.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${service.humanToken}`,
        },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 200, `API request failed: ${path}`)
      return response.json()
    }
    stage = 'seed'
    for (const item of CORPUS) {
      const added = await post('/nodes', { label: item.label, kind: 'claim' })
      const id = added.node.nodeId
      assert.equal(typeof id, 'string')
      keys.set(id, item.key)
      await post('/record', { target: id, dimensions: { confidence: 'medium' } })
    }
    await service.close()
    closeChecks.push({ phase: 'seed', closed: true })
    service = undefined
    const rowOf = (test, recalled, semantic) => {
      assert(Array.isArray(recalled.ranked))
      const failure = recalled.semanticUnavailable
      const valid = failure === undefined
      const failureKind = String(failure).split(':')[0]
      const safeFailure = [
        'unavailable',
        'timeout',
        'provider_error',
        'malformed_response',
      ].includes(failureKind)
        ? failureKind
        : 'provider_failure'
      const ranked = recalled.ranked.map((entry) => {
        assert(keys.has(entry.nodeId), 'Unexpected node outside the fixed corpus')
        if (!semantic) assert(entry.reasons.every((reason) => reason.signal === 'lexical'))
        return { key: keys.get(entry.nodeId), score: entry.score, reasons: entry.reasons }
      })
      const selected = ranked.slice(0, k).map((entry) => entry.key)
      return {
        ...test,
        valid,
        fallback: valid ? null : safeFailure,
        returned: ranked.length,
        top1Hit: valid && test.gold !== null ? selected[0] === test.gold : null,
        topkHit: valid && test.gold !== null ? selected.includes(test.gold) : null,
        goldRank:
          valid && test.gold !== null
            ? ranked.findIndex((entry) => entry.key === test.gold) + 1 || null
            : null,
        ranked,
      }
    }
    stage = 'lexical'
    session = await CognitiveSession.open({
      filePath: graph,
      scene: profile.scene,
      weights: WEIGHTS,
    })
    assert.deepEqual(
      Object.fromEntries(session.rules.map((rule) => [rule.signal, rule.weight])),
      WEIGHTS,
    )
    const lexicalRows = []
    for (const test of CASES) {
      cancelled.signal.throwIfAborted()
      lexicalRows.push(rowOf(test, await session.recall(test.question), false))
    }
    await session.close()
    closeChecks.push({ phase: 'lexical', closed: true })
    session = undefined
    assert.equal(
      counters.embeddingRequests,
      0,
      'Lexical baseline must not call an embedding provider',
    )
    let semantic = { status: configured.status, reason: configured.reason, summary: null, rows: [] }
    if (configured.settings) {
      stage = 'semantic'
      service = await startService({
        graph,
        port: 0,
        host: '127.0.0.1',
        profile,
        embeddings: configured.settings,
      })
      const rows = []
      let rules
      for (const test of CASES) {
        const recalled = await post('/recall', { question: test.question })
        rules = recalled.rules
        rows.push(rowOf(test, recalled, true))
      }
      assert(
        counters.embeddingRequests > 0,
        'Semantic evaluation requires actual endpoint requests',
      )
      const complete = rows.every((row) => row.valid)
      semantic = {
        status: complete ? 'endpoint_evaluated' : 'unverified',
        reason: complete
          ? 'model_authenticity_requires_operator_verification'
          : 'provider_failure_no_semantic_effect_claimed',
        protocol: configured.settings.protocol,
        modelSha256: createHash('sha256').update(configured.settings.model).digest('hex'),
        timeoutMs: configured.settings.timeoutMs,
        rules,
        summary: complete ? summarize(rows) : null,
        rows,
      }
    }
    const artifacts = [
      '../packages/application/dist/session.js',
      '../apps/service/dist/server.js',
      '../apps/service/dist/profile.js',
      '../packages/core/dist/retrieval/hybrid.js',
    ]
    result = {
      schema: 'cli-recall-v1',
      node: process.version,
      fixtureSha256: createHash('sha256').update(JSON.stringify({ CORPUS, CASES })).digest('hex'),
      distSha256: Object.fromEntries(
        await Promise.all(
          artifacts.map(async (path) => [
            path,
            createHash('sha256')
              .update(await readFile(new URL(path, import.meta.url)))
              .digest('hex'),
          ]),
        ),
      ),
      k,
      corpus: CORPUS,
      protocol: {
        sharedCorpus: true,
        profile: 'defaultProfile()',
        nodes: CORPUS.length,
        positiveQueries: 18,
        absentQueries: 3,
        record: { confidence: 'medium' },
        lexicalWeights: WEIGHTS,
        semanticWeights: 'application defaults',
        scopeBoost: false,
        edges: 0,
      },
      lexical: {
        summary: summarize(lexicalRows),
        byScenario: Object.fromEntries(
          ['dev', 'learn', 'discussion'].map((scenario) => [
            scenario,
            summarize(lexicalRows.filter((row) => row.scenario === scenario)),
          ]),
        ),
        byKind: Object.fromEntries(
          ['direct', 'paraphrase', 'cross-language'].map((kind) => [
            kind,
            summarize(lexicalRows.filter((row) => row.kind === kind)),
          ]),
        ),
        rows: lexicalRows,
      },
      semantic,
      requests: counters,
      limitations: [
        'Lexical is application HybridRetriever with only lexical weight, not LexicalGraphRetriever.',
        'Semantic uses default hybrid weights; it is not a semantic-only ablation.',
        'One gold per positive query: top-k hit rate equals recall@k only for these single-gold cases.',
        'Twelve synthetic English claims share one graph; scenario labels do not filter candidates.',
        'Negated hard negatives share words with gold; ties use creation time then id.',
        'Chinese queries test cross-language retrieval, not native Chinese corpus segmentation.',
        'Public recall returns at most eight items; absent queries are excluded from hit-rate denominators.',
        'No answer generation, latency benchmark, significance estimate or production-quality claim.',
        'No artificial vector scores are reported. A successful endpoint does not prove it runs a real model.',
        'Without a real local embedding endpoint, semantic effectiveness remains unverified.',
      ],
    }
  } catch (error) {
    console.error(
      `Evaluation stopped during ${stage}; no credentials or provider response details are logged.`,
    )
    throw error
  } finally {
    try {
      await Promise.all([
        service?.close().then(() => closeChecks.push({ phase: stage, closed: true })),
        session?.close().then(() => closeChecks.push({ phase: stage, closed: true })),
      ])
    } finally {
      try {
        if (directory) {
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          await assert.rejects(access(directory), { code: 'ENOENT' })
        }
      } finally {
        globalThis.fetch = originalFetch
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
      }
    }
  }
  return { ...result, cleanup: { owners: closeChecks, temporaryDirectoryRemoved: true } }
}
