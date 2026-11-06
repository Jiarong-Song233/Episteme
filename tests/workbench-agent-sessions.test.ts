import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import { SimulatedModel, workbenchProfile, type AgentEnvironment } from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The conversations the agents of this computer keep for themselves, read only and only by the person; and the
 * workbench's own conversations, which the person can rename and archive but never rewrite. Every agent file here is
 * written by the test into a temporary home: the real ones are never read.
 */

let directory: string
let home: string
let service: EpistemeService | undefined

function environment(): AgentEnvironment {
  return {
    home,
    platform: process.platform,
    appData: join(home, 'AppData'),
    env: {},
    run: () => Promise.resolve({ ok: false, output: '' }),
    bridge: { command: 'node', args: ['bridge.js'] },
  }
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

// Required: the test runner does not know `node:sqlite` as a built-in yet.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
}

const jsonl = (...lines: unknown[]): string =>
  `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`

async function call(path: string, body?: unknown, token = service?.humanToken) {
  const response = await fetch(`${service!.url}/api/v1/scene/workbench${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function serve(): Promise<EpistemeService> {
  service = await startService({
    graph: join(directory, 'graph.db'),
    port: 0,
    profile: workbenchProfile({ model: new SimulatedModel(), agentEnvironment: environment() }),
  })
  return service
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-agent-sessions-'))
  home = join(directory, 'home')
  await mkdir(home, { recursive: true })
})

afterEach(async () => {
  await service?.close()
  service = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

interface Listed {
  agent: string
  id: string
  title: string
  project?: string
}

describe('the agents’ own conversations', () => {
  beforeEach(async () => {
    await put(
      join(home, '.claude', 'projects', 'D--work-thesis', 'aaa.jsonl'),
      jsonl(
        {
          type: 'user',
          isMeta: true,
          message: { content: '<command-name>/clear</command-name>' },
          cwd: 'D:\\work\\thesis',
        },
        {
          type: 'user',
          message: { content: '帮我解释位置编码' },
          cwd: 'D:\\work\\thesis',
          timestamp: '2026-11-01T10:00:00Z',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'hidden' },
              { type: 'text', text: '位置编码给每个位置一个向量。' },
              { type: 'tool_use', name: 'Read' },
            ],
          },
          timestamp: '2026-11-01T10:00:05Z',
        },
        {
          type: 'user',
          toolUseResult: {},
          message: { content: [{ type: 'tool_result', content: 'file text' }] },
        },
        { type: 'custom-title', customTitle: '位置编码讨论', sessionId: 'aaa' },
      ),
    )
    await put(
      join(home, '.codex', 'sessions', '2026', '11', '02', 'rollout-2026-11-02T08-00-00-x.jsonl'),
      jsonl(
        {
          timestamp: '2026-11-02T08:00:00Z',
          type: 'session_meta',
          payload: { id: 'x', cwd: '/home/me/app' },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '<environment_context>cwd</environment_context>' },
            ],
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '修一下登录页的 bug' }],
          },
        },
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '已修好。' }],
          },
        },
      ),
    )
    await put(
      join(home, '.gemini', 'tmp', 'abc', 'chats', 'session-1.json'),
      JSON.stringify({
        messages: [
          { type: 'user', content: '什么是注意力' },
          { type: 'gemini', content: '注意力是加权求和。' },
        ],
      }),
    )
    await put(
      join(home, '.kimi', 'sessions', 'h', 's1', 'context.jsonl'),
      jsonl(
        { role: '_system_prompt', content: 'system' },
        { role: 'user', content: '写一首关于秋天的诗' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '秋风起。' }],
          tool_calls: [{ function: { name: 'search' } }],
        },
        { role: 'tool', content: [{ type: 'text', text: 'result' }], tool_call_id: '1' },
      ),
    )
    const folder = join(home, '.local', 'share', 'opencode')
    await mkdir(folder, { recursive: true })
    const db = new DatabaseSync(join(folder, 'opencode.db'))
    db.exec(`
      create table session (id text primary key, parent_id text, title text not null, directory text not null, time_updated integer not null);
      create table message (id text primary key, session_id text not null, time_created integer not null, data text not null);
      create table part (id text primary key, message_id text not null, time_created integer not null, data text not null);
      insert into session values ('ses_1', null, '重构存储层', '/repo', 1000);
      insert into session values ('ses_child', 'ses_1', 'sub task', '/repo', 2000);
      insert into message values ('m1', 'ses_1', 1, '{"role":"user"}');
      insert into message values ('m2', 'ses_1', 2, '{"role":"assistant"}');
      insert into part values ('p1', 'm1', 1, '{"type":"text","text":"把 JSONL 换成 SQLite"}');
      insert into part values ('p2', 'm2', 2, '{"type":"reasoning","text":"hidden"}');
      insert into part values ('p3', 'm2', 3, '{"type":"text","text":"好，先写迁移。"}');
      insert into part values ('p4', 'm2', 4, '{"type":"tool","tool":"edit"}');
    `)
    db.close()
  })

  it('lists them across agents, titled by what the person asked, leaving out what the harness injected', async () => {
    await serve()
    const listed = await call('/agent-sessions')
    expect(listed.status).toBe(200)
    const sessions = listed.body['sessions'] as Listed[]
    const byAgent = Object.fromEntries(sessions.map((session) => [session.agent, session]))
    expect(byAgent['claude-code']).toMatchObject({
      title: '位置编码讨论',
      project: 'D:\\work\\thesis',
    })
    expect(byAgent['codex']).toMatchObject({ title: '修一下登录页的 bug', project: '/home/me/app' })
    expect(byAgent['gemini-cli']).toMatchObject({ title: '什么是注意力' })
    expect(byAgent['kimi-cli']).toMatchObject({ title: '写一首关于秋天的诗' })
    expect(byAgent['opencode']).toMatchObject({
      id: 'ses_1',
      title: '重构存储层',
      project: '/repo',
    })
    // A sub-agent's session is part of its parent's, not a conversation of its own.
    expect(sessions.some((session) => session.id === 'ses_child')).toBe(false)
    expect(listed.body['agents']).toEqual(
      expect.arrayContaining([
        { id: 'claude-code', name: 'Claude Code', found: true },
        { id: 'qwen-code', name: 'Qwen Code', found: false },
      ]),
    )
  })

  it('reads one, the person’s words and the agent’s answers, without thinking or tool output', async () => {
    await serve()
    const sessions = (await call('/agent-sessions')).body['sessions'] as Listed[]
    const read = async (agent: string) => {
      const session = sessions.find((candidate) => candidate.agent === agent)!
      const reply = await call(
        `/agent-sessions/read?agent=${agent}&id=${encodeURIComponent(session.id)}`,
      )
      expect(reply.status).toBe(200)
      return (reply.body['session'] as { messages: { role: string; text: string }[] }).messages
    }
    expect(await read('claude-code')).toEqual([
      expect.objectContaining({ role: 'user', text: '帮我解释位置编码' }),
      expect.objectContaining({ role: 'assistant', text: '位置编码给每个位置一个向量。' }),
      expect.objectContaining({ role: 'tool', text: '调用了工具：Read' }),
    ])
    expect((await read('codex')).map((message) => message.text)).toEqual([
      '修一下登录页的 bug',
      '调用了工具：apply_patch',
      '已修好。',
    ])
    expect((await read('kimi-cli')).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ])
    expect((await read('opencode')).map((message) => message.text)).toEqual([
      '把 JSONL 换成 SQLite',
      '好，先写迁移。',
      '调用了工具：edit',
    ])
  })

  it('searches titles and words', async () => {
    await serve()
    const found = async (q: string) =>
      ((await call(`/agent-sessions?q=${encodeURIComponent(q)}`)).body['sessions'] as Listed[]).map(
        (s) => s.agent,
      )
    expect(await found('位置编码')).toEqual(['claude-code'])
    expect(await found('已修好')).toEqual(['codex'])
    expect(await found('先写迁移')).toEqual(['opencode'])
    expect(await found('不存在的词')).toEqual([])
  })

  it('opens nothing outside an agent’s own folder', async () => {
    await put(join(home, 'secret.jsonl'), jsonl({ type: 'user', message: { content: 'secret' } }))
    await serve()
    const outside = Buffer.from('../../secret.jsonl').toString('base64url')
    const reply = await call(`/agent-sessions/read?agent=claude-code&id=${outside}`)
    expect(reply).toMatchObject({ status: 422, body: { code: 'unknown_session' } })
    expect(await readFile(join(home, 'secret.jsonl'), 'utf8')).toContain('secret')
  })

  it('shows them to the person only', async () => {
    const users = join(directory, 'users.json')
    const lin = await addPerson(users, 'Lin')
    const agent = await addToken(users, lin, 'agent', 'claude-code')
    const human = await addToken(users, lin, 'human', 'workspace')
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      mode: 'shared',
      users,
      publicOrigin: 'http://127.0.0.1',
      profile: workbenchProfile({ model: new SimulatedModel(), agentEnvironment: environment() }),
    })
    expect((await call('/agent-sessions', undefined, agent)).status).toBe(403)
    expect((await call('/agent-sessions/read?agent=codex&id=x', undefined, agent)).status).toBe(403)
    expect((await call('/agent-sessions', undefined, undefined)).status).toBe(401)
    expect((await call('/agent-sessions', undefined, human)).status).toBe(200)
  })
})

describe('the workbench’s own conversations', () => {
  it('can be renamed and archived by the person, keeping every word', async () => {
    await serve()
    const space = ((await call('/spaces', { name: '论文' })).body['space'] as { id: string }).id
    const asked = await call('/ask', { space, question: '这篇论文讲了什么？' })
    const thread = asked.body['thread'] as string

    let listed = (await call('/conversations')).body['conversations'] as Record<string, unknown>[]
    expect(listed).toEqual([
      expect.objectContaining({
        id: thread,
        title: '这篇论文讲了什么？',
        space: { id: space, name: '论文' },
        byPerson: true,
        turns: 2,
        archived: false,
      }),
    ])

    expect((await call('/conversations/update', { thread, title: '  论文  概要 ' })).status).toBe(
      200,
    )
    expect(
      ((await call(`/sessions?space=${space}`)).body['sessions'] as { title: string }[])[0]!.title,
    ).toBe('论文 概要')
    await call('/conversations/update', { thread, archived: true })
    expect((await call(`/sessions?space=${space}`)).body['sessions']).toEqual([])
    expect((await call('/conversations')).body['conversations']).toEqual([])
    listed = (await call('/conversations?archived=1')).body['conversations'] as Record<
      string,
      unknown
    >[]
    expect(listed).toEqual([
      expect.objectContaining({ id: thread, title: '论文 概要', archived: true }),
    ])

    // Archived is out of the list, not gone: its words are all there.
    const session = await call(`/session?thread=${thread}`)
    expect((session.body['turns'] as unknown[]).length).toBe(2)
    await call('/conversations/update', { thread, archived: false, title: '' })
    expect(
      ((await call(`/sessions?space=${space}`)).body['sessions'] as { title: string }[])[0]!.title,
    ).toBe('这篇论文讲了什么？')
    expect(
      (await call('/conversations/update', { thread: 'nope', archived: true })).body['code'],
    ).toBe('unknown_thread')
  })

  it('cannot be renamed or archived with an agent’s credential', async () => {
    const users = join(directory, 'users.json')
    const lin = await addPerson(users, 'Lin')
    const agent = await addToken(users, lin, 'agent', 'claude-code')
    const human = await addToken(users, lin, 'human', 'workspace')
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      mode: 'shared',
      users,
      publicOrigin: 'http://127.0.0.1',
      profile: workbenchProfile({ model: new SimulatedModel() }),
    })
    const space = ((await call('/spaces', { name: 's' }, human)).body['space'] as { id: string }).id
    const thread = (await call('/ask', { space, question: 'q' }, human)).body['thread'] as string
    expect((await call('/conversations/update', { thread, archived: true }, agent)).status).toBe(
      403,
    )
    expect(
      ((await call('/conversations', undefined, human)).body['conversations'] as unknown[]).length,
    ).toBe(1)
  })
})
