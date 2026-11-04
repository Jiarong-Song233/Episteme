/**
 * Open WebUI as a comparison system for scripts/evaluate.mjs. It is run, never vendored: the caller installs a pinned
 * release into a virtual environment of its own (docs/research/evaluation/round-3.md has the commands) and passes the path.
 *
 * Open WebUI talks to the model through a small proxy in this process, for two reasons: the real key stays out of a third
 * party's process and database, and every call it makes, including the ones it decides to make itself, is counted and
 * capped the same way as for the other systems.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const MODEL_TIMEOUT_MS = 60_000
const MAX_TOKENS_SPENT = 1_000_000
// The first start downloads about 650 MB of embedding model before it answers at all.
const STARTUP_TIMEOUT_MS = 40 * 60_000

const listening = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

/** Answers `GET /models` with the one model under test and forwards completions, counting what they spend. */
export async function startModelProxy({ baseUrl, apiKey, model, limit, spent }) {
  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    if (request.method === 'GET' && request.url.endsWith('/models')) {
      reply(200, { object: 'list', data: [{ id: model, object: 'model' }] })
      return
    }
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
      reply(404, { error: { message: 'not forwarded' } })
      return
    }
    if (spent.calls >= limit || spent.tokens >= MAX_TOKENS_SPENT) {
      reply(429, { error: { message: `over the evaluation budget of ${limit} calls` } })
      return
    }
    spent.calls += 1
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    try {
      const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        body: Buffer.concat(chunks),
        headers: {
          'content-type': 'application/json',
          ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      })
      const text = await upstream.text()
      if (!upstream.ok) spent.failures += 1
      const used = [...text.matchAll(/"total_tokens"\s*:\s*(\d+)/g)].at(-1)?.[1]
      spent.tokens += Number(used ?? 0)
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      })
      response.end(text)
    } catch (error) {
      spent.failures += 1
      reply(502, { error: { message: String(error.message ?? error) } })
    }
  })
  const port = await listening(server)
  return { url: `http://127.0.0.1:${port}/v1`, close: () => server.close() }
}

async function freePort() {
  const probe = createServer()
  const port = await listening(probe)
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** The configuration a person gets out of the box, plus only what running it here needs. */
export function environmentFor({ home, proxyUrl, settings }) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('EPISTEME_MODEL_')),
  )
  return {
    ...inherited,
    PYTHONUTF8: '1',
    DATA_DIR: mkdtempSync(join(home, 'data-')),
    HF_HOME: join(home, 'huggingface'),
    WEBUI_SECRET_KEY: randomBytes(24).toString('hex'),
    WEBUI_AUTH: 'False',
    ENABLE_OLLAMA_API: 'False',
    OPENAI_API_BASE_URL: proxyUrl,
    OPENAI_API_KEY: 'held-by-the-evaluation-proxy',
    // No word home from a throwaway evaluation instance.
    SCARF_NO_ANALYTICS: 'true',
    DO_NOT_TRACK: 'true',
    ANONYMIZED_TELEMETRY: 'false',
    ENABLE_VERSION_UPDATE_CHECK: 'false',
    ...settings,
  }
}

/** Starts `open-webui serve` and returns once it answers, however long the first embedding download takes. */
export async function startServer({ venv, environment, log }) {
  const port = await freePort()
  const binary =
    process.platform === 'win32'
      ? join(venv, 'Scripts', 'open-webui.exe')
      : join(venv, 'bin', 'open-webui')
  const child = spawn(binary, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const tail = []
  const keep = (chunk) => {
    tail.push(String(chunk))
    if (tail.length > 40) tail.shift()
    log?.(String(chunk))
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  let exited
  child.once('exit', (code) => {
    exited = code ?? 'signal'
  })
  const stop = () => {
    // The entry point is a launcher on Windows; the server is its child, so the tree has to go.
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill()
    }
  }
  const url = `http://127.0.0.1:${port}`
  const startedAt = performance.now()
  while (performance.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (exited !== undefined) {
      throw new Error(`open-webui exited with ${exited}: ${tail.join('').slice(-1500)}`)
    }
    const up = await fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (up) return { url, startupMs: Math.round(performance.now() - startedAt), stop }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  stop()
  throw new Error('open-webui did not answer within the startup limit')
}

/** Connects with the account Open WebUI creates for itself when sign-in is switched off. */
async function connect(url) {
  const response = await fetch(`${url}/api/v1/auths/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@localhost', password: 'admin' }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`signin: ${response.status} ${JSON.stringify(body)}`)
  return caller(url, body.token)
}

/** Requests as one person. Throws on a refusal, so a step that did not happen cannot be read as done. */
export function caller(url, token) {
  const headers = { authorization: `Bearer ${token}` }
  return async (path, init = {}) => {
    const answer = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      },
    })
    const text = await answer.text()
    if (!answer.ok) throw new Error(`${path}: ${answer.status} ${text.slice(0, 500)}`)
    return JSON.parse(text)
  }
}

/**
 * What a reader can follow from an answer. Open WebUI numbers `[n]` per file in the order files first appear, not per
 * passage (`get_source_context` in its utils/middleware.py), so `[n]` points at every passage it retrieved from that file.
 * A file the answer never points at is not counted as cited, though the page lists it under the answer.
 */
export function readAnswer(body) {
  const text = String(body.choices?.[0]?.message?.content ?? '')
  const numbers = new Map()
  const passages = (body.sources ?? []).flatMap((source) =>
    (source.document ?? []).map((quote, index) => {
      const file = String(source.metadata?.[index]?.source ?? source.source?.id ?? 'N/A')
      if (!numbers.has(file)) numbers.set(file, numbers.size + 1)
      return { file, quote: String(quote), n: numbers.get(file) }
    }),
  )
  const pointedAt = new Set([...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))
  return {
    text,
    citations: passages
      .filter((passage) => pointedAt.has(passage.n))
      .map(({ file, quote }) => ({ file, quote })),
    retrieved: passages.map((passage) => ({ file: passage.file, quote: passage.quote })),
    evidence: [],
  }
}

/**
 * @param options.venv    the virtual environment holding the pinned release
 * @param options.home    where its data and downloaded embedding model live; never inside the repository
 * @param options.settings environment overrides that define the configuration under test
 */
export async function openWebUI({ venv, home, settings = {}, describe, model, limit, spent, log }) {
  const proxy = await startModelProxy({
    baseUrl: process.env.EPISTEME_MODEL_BASE_URL,
    apiKey: process.env.EPISTEME_MODEL_API_KEY,
    model,
    limit,
    spent,
  })
  const environment = environmentFor({ home, proxyUrl: proxy.url, settings })
  const server = await startServer({ venv, environment, log })
  const call = await connect(server.url)
  let collection
  return {
    describe,
    startupMs: server.startupMs,
    async prepare(files) {
      const created = await call('/api/v1/knowledge/create', {
        method: 'POST',
        body: JSON.stringify({ name: '评测', description: '虚构评测材料' }),
      })
      collection = created.id
      for (const file of files) {
        const form = new FormData()
        form.append('file', new Blob([file.text], { type: 'text/markdown' }), file.name)
        const uploaded = await call('/api/v1/files/?process=true&process_in_background=false', {
          method: 'POST',
          body: form,
        })
        await call(`/api/v1/knowledge/${collection}/file/add`, {
          method: 'POST',
          body: JSON.stringify({ file_id: uploaded.id }),
        })
      }
    },
    async ask(question) {
      const body = await call('/api/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: 'user', content: question }],
          files: [{ type: 'collection', id: collection }],
        }),
      })
      return readAnswer(body)
    },
    async close() {
      server.stop()
      proxy.close()
      // Sqlite and the vector store let go of their files a moment after the process dies.
      rmSync(environment.DATA_DIR, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 500,
      })
    },
  }
}
