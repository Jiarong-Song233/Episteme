#!/usr/bin/env node
/**
 * Walks Open WebUI's nearest equivalents of what Episteme claims to be for: keeping an understanding, revising it, and
 * another person using it. Each step records what actually came back, so a missing capability is an observation and not
 * a reading of its README. Absence is only claimed for this release and through the routes tried here.
 *
 *   node scripts/evaluate-openwebui-probe.mjs --openwebui-home <dir> --out probe.json
 *
 * The accounts are throwaway ones in a throwaway local instance, with generated passwords that are never written down.
 */
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { caller, environmentFor, startModelProxy, startServer } from './evaluate-openwebui.mjs'

const { values } = parseArgs({
  options: {
    'openwebui-home': { type: 'string' },
    out: { type: 'string' },
    'max-calls': { type: 'string', default: '10' },
  },
})
const home = values['openwebui-home']
const model = process.env.EPISTEME_MODEL_NAME
if (
  home === undefined ||
  model === undefined ||
  process.env.EPISTEME_MODEL_BASE_URL === undefined
) {
  throw new Error('needs --openwebui-home, EPISTEME_MODEL_BASE_URL and EPISTEME_MODEL_NAME')
}

const spent = { calls: 0, tokens: 0, failures: 0 }
const proxy = await startModelProxy({
  baseUrl: process.env.EPISTEME_MODEL_BASE_URL,
  apiKey: process.env.EPISTEME_MODEL_API_KEY,
  model,
  limit: Number(values['max-calls']),
  spent,
})
const environment = environmentFor({
  home,
  proxyUrl: proxy.url,
  // Models are private to the admin by default, which would make the second person's steps fail for an unrelated reason.
  settings: { WEBUI_AUTH: 'True', BYPASS_MODEL_ACCESS_CONTROL: 'True' },
})
const server = await startServer({ venv: join(home, 'venv'), environment })

const steps = []
/** A refusal is a finding here, so it is kept rather than thrown. */
async function step(name, run) {
  try {
    const observed = await run()
    steps.push({ name, ok: true, observed })
    return observed
  } catch (error) {
    steps.push({ name, ok: false, observed: String(error.message ?? error).slice(0, 400) })
    return undefined
  }
}

const json = (body) => ({ method: 'POST', body: JSON.stringify(body) })
const chat = (who, content, extra = {}) =>
  who(
    '/api/chat/completions',
    json({ model, stream: false, messages: [{ role: 'user', content }], ...extra }),
  )
const said = (answer) => String(answer.choices?.[0]?.message?.content ?? '')

try {
  const password = randomBytes(18).toString('base64url')
  const signup = await fetch(`${server.url}/api/v1/auths/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'lin', email: 'lin@example.test', password }),
  }).then((response) => response.json())
  const lin = caller(server.url, signup.token)
  const added = await lin(
    '/api/v1/auths/add',
    json({ name: 'wei', email: 'wei@example.test', password, role: 'user' }),
  )
  const wei = caller(server.url, added.token)

  // Memory: the nearest thing to a saved understanding.
  const memory = await step('记忆：保存一条理解', () =>
    lin('/api/v1/memories/add', json({ content: '我的理解：潮汐协议的降级阈值是 72%。' })),
  )
  await step('记忆：修正后旧说法还在不在', async () => {
    await lin(`/api/v1/memories/${memory.id}/update`, json({ content: '我的理解：阈值是 80%。' }))
    const all = await lin('/api/v1/memories/')
    return {
      count: all.length,
      fields: Object.keys(all[0]),
      keepsOldText: JSON.stringify(all).includes('72%'),
    }
  })
  await step('记忆：新会话能否用上修正后的说法', async () => {
    const answer = await chat(lin, '我记下的那个降级阈值是多少？只回答数字。', {
      features: { memory: true },
    })
    return {
      answer: said(answer),
      usedRevision: /80/.test(said(answer)),
      sources: answer.sources?.length ?? 0,
    }
  })
  await step('记忆：另一个人能否看到', async () => {
    const all = await wei('/api/v1/memories/')
    return { count: all.length }
  })

  // Notes: the nearest thing to something published to another person.
  const note = await step('笔记：保存一条理解', () =>
    lin(
      '/api/v1/notes/create',
      json({ title: '潮汐协议', data: { content: { md: '阈值是 72%，依据是规范第二节。' } } }),
    ),
  )
  await step('笔记：共享前另一个人能否读', () => wei(`/api/v1/notes/${note.id}`))
  await step('笔记：只读共享给另一个人', async () => {
    const shared = await lin(
      `/api/v1/notes/${note.id}/access/update`,
      json({
        access_grants: [{ principal_type: 'user', principal_id: added.id, permission: 'read' }],
      }),
    )
    return { grants: shared.access_grants?.length ?? 0 }
  })
  await step('笔记：另一个人读到', async () => {
    const read = await wei(`/api/v1/notes/${note.id}`)
    return { text: read.data?.content?.md, fields: Object.keys(read) }
  })
  await step('笔记：只读的人能否改', () =>
    wei(`/api/v1/notes/${note.id}/update`, json({ data: { content: { md: '被别人改了' } } })),
  )
  await step('笔记：作者修正后，读者看到什么，旧版本还在不在', async () => {
    await lin(
      `/api/v1/notes/${note.id}/update`,
      json({ data: { content: { md: '阈值是 80%，上一版读错了。' } } }),
    )
    const read = await wei(`/api/v1/notes/${note.id}`)
    return {
      text: read.data?.content?.md,
      keepsOldText: JSON.stringify(read).includes('72%'),
      dataFields: Object.keys(read.data ?? {}),
    }
  })
  await step('笔记：另一个人提问时引用它，来源能否认出作者', async () => {
    const answer = await chat(wei, '这份笔记说阈值是多少？', {
      files: [{ type: 'note', id: note.id }],
    })
    return { answer: said(answer), sources: JSON.stringify(answer.sources ?? []).slice(0, 600) }
  })

  const report = { release: '0.12.5', model, spent, steps }
  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`)
  else console.log(JSON.stringify(report, null, 2))
} finally {
  server.stop()
  proxy.close()
  rmSync(environment.DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
