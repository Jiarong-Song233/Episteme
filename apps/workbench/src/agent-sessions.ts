import { createReadStream, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { SceneRoute } from '@episteme/service'
import type { AgentEnvironment } from './agents.js'
import { refuse, required } from './requests.js'

/**
 * The conversations the agents of this computer keep for themselves, to look through and search. Read only: nothing
 * here writes to an agent's files, and nothing read here reaches an agent or a model. Both routes are the person's
 * own (WORKBENCH_PRIVATE_ROUTES).
 */

export interface AgentSessionSummary {
  readonly agent: string
  readonly id: string
  readonly title: string
  /** The folder the agent worked in, when it says. */
  readonly project?: string
  readonly updatedAt: number
  readonly bytes?: number
}

export interface AgentSessionMessage {
  readonly role: 'user' | 'assistant' | 'tool'
  readonly text: string
  readonly at?: number
}

export interface AgentSession {
  readonly summary: AgentSessionSummary
  readonly messages: readonly AgentSessionMessage[]
  /** Whether messages or their words were cut short to keep the page light. */
  readonly truncated: boolean
}

interface SessionReader {
  readonly agent: string
  readonly name: string
  /** Where it keeps them; nothing outside this folder is ever opened. */
  readonly root: (env: AgentEnvironment) => string
  readonly list: (env: AgentEnvironment, limit: number) => Promise<AgentSessionSummary[]>
  readonly read: (env: AgentEnvironment, id: string) => Promise<AgentSession | undefined>
  /** The raw text of one session, for searching, when it is a file. */
  readonly file?: (env: AgentEnvironment, id: string) => string | undefined
}

const MAX_MESSAGES = 600
const MAX_TEXT = 6000
const TITLE = 80
const HEAD = 256 * 1024
const TAIL = 64 * 1024
const MAX_SEARCH_FILE = 32 * 1024 * 1024

function oneLine(value: string, max = TITLE): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function clipped(value: string): { text: string; cut: boolean } {
  return value.length > MAX_TEXT
    ? { text: `${value.slice(0, MAX_TEXT)}…`, cut: true }
    : { text: value, cut: false }
}

/** An id that names a file under the root without being a path anyone can send back to reach another file. */
function idOf(root: string, file: string): string {
  return Buffer.from(relative(root, file).split(sep).join('/'), 'utf8').toString('base64url')
}

function fileOf(root: string, id: string): string | undefined {
  let path: string
  try {
    path = resolve(root, Buffer.from(id, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  const inside = resolve(root) + sep
  return path.startsWith(inside) && existsSync(path) ? path : undefined
}

/** Files under `root` matching `pattern`, newest first, at most `limit`. Walks only `depth` folders down. */
async function newestFiles(root: string, pattern: RegExp, depth: number, limit: number) {
  const found: { path: string; mtime: number; size: number }[] = []
  async function walk(folder: string, left: number): Promise<void> {
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        if (left > 0) await walk(path, left - 1)
      } else if (pattern.test(entry.name)) {
        try {
          const info = await stat(path)
          found.push({ path, mtime: info.mtimeMs, size: info.size })
        } catch {
          // Gone while walking: an agent removed it.
        }
      }
    }
  }
  await walk(root, depth)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

/** The first and last part of a file, which say what it is about without reading all of it. */
async function ends(path: string, size: number): Promise<{ head: string[]; tail: string[] }> {
  const handle = await open(path, 'r')
  try {
    const headBytes = Buffer.alloc(Math.min(size, HEAD))
    await handle.read(headBytes, 0, headBytes.length, 0)
    const head = headBytes.toString('utf8').split('\n')
    if (size > headBytes.length) head.pop() // cut mid-line
    let tail: string[] = []
    if (size > HEAD) {
      const tailBytes = Buffer.alloc(Math.min(size - HEAD, TAIL))
      await handle.read(tailBytes, 0, tailBytes.length, size - tailBytes.length)
      tail = tailBytes.toString('utf8').split('\n').slice(1)
    }
    return { head, tail }
  } finally {
    await handle.close()
  }
}

function parsed(line: string): Record<string, unknown> | undefined {
  if (line.trim() === '') return undefined
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

async function* linesOf(path: string): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    const value = parsed(line)
    if (value !== undefined) yield value
  }
}

const timeOf = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : at
}

/** The words of a message whose content is a string or a list of parts, and the tools it called. */
function wordsOf(content: unknown): { text: string; tools: string[] } {
  if (typeof content === 'string') return { text: content, tools: [] }
  if (!Array.isArray(content)) return { text: '', tools: [] }
  const texts: string[] = []
  const tools: string[] = []
  for (const part of content as Record<string, unknown>[]) {
    if (typeof part !== 'object' || part === null) continue
    const kind = part['type']
    if (
      (kind === 'text' || kind === 'input_text' || kind === 'output_text') &&
      typeof part['text'] === 'string'
    ) {
      texts.push(part['text'])
    } else if (kind === 'tool_use' && typeof part['name'] === 'string') {
      tools.push(part['name'])
    }
  }
  return { text: texts.join('\n'), tools }
}

/** What an agent's harness puts in the user's place, which the person never typed. */
function injected(text: string): boolean {
  const start = text.trimStart()
  return (
    start === '' ||
    start.startsWith('<environment_context>') ||
    start.startsWith('<user_instructions>') ||
    start.startsWith('# AGENTS.md') ||
    start.startsWith('<system-reminder>') ||
    start.startsWith('<command-') ||
    start.startsWith('<local-command-') ||
    start.startsWith('Caveat: The messages below')
  )
}

class Messages {
  readonly list: AgentSessionMessage[] = []
  truncated = false
  push(role: AgentSessionMessage['role'], text: string, at?: number): void {
    if (text.trim() === '') return
    if (this.list.length >= MAX_MESSAGES) {
      this.truncated = true
      return
    }
    const { text: kept, cut } = clipped(text)
    if (cut) this.truncated = true
    this.list.push({ role, text: kept, ...(at === undefined ? {} : { at }) })
  }
}

// Claude Code: ~/.claude/projects/<project>/<session>.jsonl, one event per line.
const claudeCode: SessionReader = {
  agent: 'claude-code',
  name: 'Claude Code',
  root: (env) => join(env.home, '.claude', 'projects'),
  file: (env, id) => fileOf(claudeCode.root(env), id),
  async list(env, limit) {
    const root = claudeCode.root(env)
    const files = await newestFiles(root, /\.jsonl$/, 1, limit)
    return Promise.all(
      files.map(async (file) => {
        const { head, tail } = await ends(file.path, file.size).catch(() => ({
          head: [],
          tail: [],
        }))
        let title: string | undefined
        let first: string | undefined
        let project: string | undefined
        for (const line of [...head, ...tail]) {
          const event = parsed(line)
          if (event === undefined) continue
          if (event['type'] === 'custom-title' && typeof event['customTitle'] === 'string')
            title = event['customTitle']
          if (event['type'] === 'summary' && typeof event['summary'] === 'string')
            title ??= event['summary']
          if (project === undefined && typeof event['cwd'] === 'string') project = event['cwd']
          if (first === undefined && event['type'] === 'user' && event['isMeta'] !== true) {
            const message = event['message'] as { content?: unknown } | undefined
            const { text } = wordsOf(message?.content)
            if (!injected(text) && event['toolUseResult'] === undefined) first = text
          }
        }
        return {
          agent: claudeCode.agent,
          id: idOf(root, file.path),
          title: oneLine(title ?? first ?? basename(file.path, '.jsonl')),
          ...(project === undefined ? {} : { project }),
          updatedAt: file.mtime,
          bytes: file.size,
        }
      }),
    )
  },
  async read(env, id) {
    const path = claudeCode.file!(env, id)
    if (path === undefined) return undefined
    const messages = new Messages()
    let title: string | undefined
    let project: string | undefined
    for await (const event of linesOf(path)) {
      if (event['type'] === 'custom-title' && typeof event['customTitle'] === 'string')
        title = event['customTitle']
      if (project === undefined && typeof event['cwd'] === 'string') project = event['cwd']
      if (
        event['isSidechain'] === true ||
        event['isMeta'] === true ||
        event['isCompactSummary'] === true
      )
        continue
      const at = timeOf(event['timestamp'])
      const message = event['message'] as { content?: unknown } | undefined
      if (event['type'] === 'user') {
        if (event['toolUseResult'] !== undefined) continue
        const { text } = wordsOf(message?.content)
        if (!injected(text)) messages.push('user', text, at)
      } else if (event['type'] === 'assistant') {
        const { text, tools } = wordsOf(message?.content)
        messages.push('assistant', text, at)
        if (tools.length > 0) messages.push('tool', `调用了工具：${tools.join('、')}`, at)
      }
    }
    const info = await stat(path)
    const first = messages.list.find((message) => message.role === 'user')?.text
    return {
      summary: {
        agent: claudeCode.agent,
        id,
        title: oneLine(title ?? first ?? basename(path, '.jsonl')),
        ...(project === undefined ? {} : { project }),
        updatedAt: info.mtimeMs,
        bytes: info.size,
      },
      messages: messages.list,
      truncated: messages.truncated,
    }
  },
}

// Codex: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl.
const codex: SessionReader = {
  agent: 'codex',
  name: 'Codex',
  root: (env) => join(env.env['CODEX_HOME'] ?? join(env.home, '.codex'), 'sessions'),
  file: (env, id) => fileOf(codex.root(env), id),
  async list(env, limit) {
    const root = codex.root(env)
    const files = await newestFiles(root, /^rollout-.*\.jsonl$/, 3, limit)
    return Promise.all(
      files.map(async (file) => {
        const { head } = await ends(file.path, file.size).catch(() => ({ head: [] as string[] }))
        let first: string | undefined
        let project: string | undefined
        for (const line of head) {
          const event = parsed(line)
          const payload = event?.['payload'] as Record<string, unknown> | undefined
          if (payload === undefined) continue
          if (event!['type'] === 'session_meta' && typeof payload['cwd'] === 'string')
            project = payload['cwd']
          if (first === undefined && payload['type'] === 'message' && payload['role'] === 'user') {
            const { text } = wordsOf(payload['content'])
            if (!injected(text)) first = text
          }
        }
        return {
          agent: codex.agent,
          id: idOf(root, file.path),
          title: oneLine(first ?? basename(file.path, '.jsonl')),
          ...(project === undefined ? {} : { project }),
          updatedAt: file.mtime,
          bytes: file.size,
        }
      }),
    )
  },
  async read(env, id) {
    const path = codex.file!(env, id)
    if (path === undefined) return undefined
    const messages = new Messages()
    let project: string | undefined
    for await (const event of linesOf(path)) {
      const payload = event['payload'] as Record<string, unknown> | undefined
      if (payload === undefined) continue
      const at = timeOf(event['timestamp'])
      if (event['type'] === 'session_meta' && typeof payload['cwd'] === 'string')
        project = payload['cwd']
      if (event['type'] !== 'response_item') continue
      if (
        payload['type'] === 'message' &&
        (payload['role'] === 'user' || payload['role'] === 'assistant')
      ) {
        const { text } = wordsOf(payload['content'])
        if (payload['role'] === 'user' && injected(text)) continue
        messages.push(payload['role'], text, at)
      } else if (
        (payload['type'] === 'function_call' || payload['type'] === 'custom_tool_call') &&
        typeof payload['name'] === 'string'
      ) {
        messages.push('tool', `调用了工具：${payload['name']}`, at)
      }
    }
    const info = await stat(path)
    const first = messages.list.find((message) => message.role === 'user')?.text
    return {
      summary: {
        agent: codex.agent,
        id,
        title: oneLine(first ?? basename(path, '.jsonl')),
        ...(project === undefined ? {} : { project }),
        updatedAt: info.mtimeMs,
        bytes: info.size,
      },
      messages: messages.list,
      truncated: messages.truncated,
    }
  },
}

/** Gemini CLI and its forks: <home>/tmp/<project hash>/chats/session-*.json, one JSON object per session. */
function geminiLike(agent: string, name: string, folder: string): SessionReader {
  const reader: SessionReader = {
    agent,
    name,
    root: (env) => join(env.home, folder, 'tmp'),
    file: (env, id) => fileOf(reader.root(env), id),
    async list(env, limit) {
      const root = reader.root(env)
      const files = await newestFiles(root, /^session-.*\.json$/, 2, limit)
      return Promise.all(
        files.map(async (file) => {
          const session = file.size < 8 * 1024 * 1024 ? await chat(file.path) : undefined
          const first = session?.list.find((message) => message.role === 'user')?.text
          return {
            agent,
            id: idOf(root, file.path),
            title: oneLine(first ?? basename(file.path, '.json')),
            updatedAt: file.mtime,
            bytes: file.size,
          }
        }),
      )
    },
    async read(env, id) {
      const path = reader.file!(env, id)
      if (path === undefined) return undefined
      const session = await chat(path)
      if (session === undefined) return undefined
      const info = await stat(path)
      const first = session.list.find((message) => message.role === 'user')?.text
      return {
        summary: {
          agent,
          id,
          title: oneLine(first ?? basename(path, '.json')),
          updatedAt: info.mtimeMs,
          bytes: info.size,
        },
        messages: session.list,
        truncated: session.truncated,
      }
    },
  }
  async function chat(path: string): Promise<Messages | undefined> {
    let value: unknown
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return undefined
    }
    const list = (value as { messages?: unknown }).messages
    if (!Array.isArray(list)) return undefined
    const messages = new Messages()
    for (const message of list as Record<string, unknown>[]) {
      const kind = message['type']
      const content = message['content']
      const text = Array.isArray(content)
        ? (content as { text?: unknown }[])
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
            .join('')
        : typeof content === 'string'
          ? content
          : ''
      const at = timeOf(message['timestamp'])
      if (kind === 'user') messages.push('user', text, at)
      else if (kind === 'gemini' || kind === 'model' || kind === 'assistant')
        messages.push('assistant', text, at)
    }
    return messages
  }
  return reader
}

// Kimi CLI: ~/.kimi/sessions/<project hash>/<session>/context.jsonl, in the OpenAI message shape.
const kimi: SessionReader = {
  agent: 'kimi-cli',
  name: 'Kimi CLI',
  root: (env) => join(env.home, '.kimi', 'sessions'),
  file: (env, id) => fileOf(kimi.root(env), id),
  async list(env, limit) {
    const root = kimi.root(env)
    const files = await newestFiles(root, /^context\.jsonl$/, 2, limit)
    return Promise.all(
      files.map(async (file) => {
        const { head } = await ends(file.path, file.size).catch(() => ({ head: [] as string[] }))
        let first: string | undefined
        for (const line of head) {
          const message = parsed(line)
          if (message?.['role'] !== 'user') continue
          const { text } = wordsOf(message['content'])
          if (!injected(text)) {
            first = text
            break
          }
        }
        return {
          agent: kimi.agent,
          id: idOf(root, file.path),
          title: oneLine(first ?? basename(dirname(file.path))),
          updatedAt: file.mtime,
          bytes: file.size,
        }
      }),
    )
  },
  async read(env, id) {
    const path = kimi.file!(env, id)
    if (path === undefined) return undefined
    const messages = new Messages()
    for await (const message of linesOf(path)) {
      const role = message['role']
      if (role === 'user' || role === 'assistant') {
        const { text } = wordsOf(message['content'])
        if (role === 'user' && injected(text)) continue
        messages.push(role, text)
        const calls = message['tool_calls']
        if (Array.isArray(calls) && calls.length > 0) {
          const names = (calls as { function?: { name?: unknown } }[])
            .map((call) => call.function?.name)
            .filter((name): name is string => typeof name === 'string')
          if (names.length > 0) messages.push('tool', `调用了工具：${names.join('、')}`)
        }
      }
    }
    const info = await stat(path)
    const first = messages.list.find((message) => message.role === 'user')?.text
    return {
      summary: {
        agent: kimi.agent,
        id,
        title: oneLine(first ?? basename(dirname(path))),
        updatedAt: info.mtimeMs,
        bytes: info.size,
      },
      messages: messages.list,
      truncated: messages.truncated,
    }
  },
}

interface SqliteDatabase {
  prepare(sql: string): {
    all(...values: unknown[]): Record<string, unknown>[]
    get(...values: unknown[]): Record<string, unknown> | undefined
  }
  close(): void
}

/** Node's own SQLite, opened read only; `undefined` on a Node without it. */
function openReadOnly(path: string): SqliteDatabase | undefined {
  if (!existsSync(path)) return undefined
  try {
    // Required rather than imported: some bundlers do not know `node:sqlite` yet and rewrite the name.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase
    }
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return undefined
  }
}

/** A cell of an SQLite row as text; anything that is not text or a number reads as empty. */
function cellText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'bigint'
      ? String(value)
      : ''
}

// opencode: ~/.local/share/opencode/opencode.db (XDG_DATA_HOME), sessions, messages and their parts.
const OPENCODE = 'opencode'
const opencodeRoot = (env: AgentEnvironment): string =>
  join(env.env['XDG_DATA_HOME'] ?? join(env.home, '.local', 'share'), 'opencode')

function opencodeSummary(row: Record<string, unknown>, id: string): AgentSessionSummary {
  return {
    agent: OPENCODE,
    id,
    title: oneLine(cellText(row['title']) || id),
    ...(typeof row['directory'] === 'string' ? { project: row['directory'] } : {}),
    updatedAt: Number(row['time_updated']),
  }
}

function listOpencode(env: AgentEnvironment, limit: number): AgentSessionSummary[] {
  const db = openReadOnly(join(opencodeRoot(env), 'opencode.db'))
  if (db === undefined) return []
  try {
    return db
      .prepare(
        'select id, title, directory, time_updated from session where parent_id is null order by time_updated desc limit ?',
      )
      .all(limit)
      .map((row) => opencodeSummary(row, cellText(row['id'])))
  } catch {
    return []
  } finally {
    db.close()
  }
}

function readOpencode(env: AgentEnvironment, id: string): AgentSession | undefined {
  const db = openReadOnly(join(opencodeRoot(env), 'opencode.db'))
  if (db === undefined) return undefined
  try {
    const session = db
      .prepare('select id, title, directory, time_updated from session where id = ?')
      .get(id)
    if (session === undefined) return undefined
    const messages = new Messages()
    const rows = db
      .prepare(
        `select m.id as message, m.data as message_data, m.time_created as at, p.data as part_data
         from message m left join part p on p.message_id = m.id
         where m.session_id = ? order by m.time_created, p.time_created`,
      )
      .all(id)
    let current:
      | { id: string; role: 'user' | 'assistant'; at: number; texts: string[]; tools: string[] }
      | undefined
    const flush = (): void => {
      if (current === undefined) return
      messages.push(current.role, current.texts.join('\n'), current.at)
      if (current.tools.length > 0)
        messages.push('tool', `调用了工具：${current.tools.join('、')}`, current.at)
    }
    for (const row of rows) {
      const messageId = cellText(row['message'])
      if (current?.id !== messageId) {
        flush()
        const data = parsed(cellText(row['message_data'])) ?? {}
        current = {
          id: messageId,
          role: data['role'] === 'user' ? 'user' : 'assistant',
          at: Number(row['at']),
          texts: [],
          tools: [],
        }
      }
      const part = parsed(cellText(row['part_data']))
      if (
        part?.['type'] === 'text' &&
        typeof part['text'] === 'string' &&
        part['synthetic'] !== true
      ) {
        current.texts.push(part['text'])
      } else if (part?.['type'] === 'tool' && typeof part['tool'] === 'string') {
        current.tools.push(part['tool'])
      }
    }
    flush()
    return {
      summary: opencodeSummary(session, id),
      messages: messages.list,
      truncated: messages.truncated,
    }
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

const opencode: SessionReader = {
  agent: OPENCODE,
  name: 'opencode',
  root: opencodeRoot,
  list: (env, limit) => Promise.resolve(listOpencode(env, limit)),
  read: (env, id) => Promise.resolve(readOpencode(env, id)),
}

export const SESSION_READERS: readonly SessionReader[] = [
  claudeCode,
  codex,
  geminiLike('gemini-cli', 'Gemini CLI', '.gemini'),
  geminiLike('qwen-code', 'Qwen Code', '.qwen'),
  kimi,
  opencode,
]

/** Whether the raw text of a session holds every word, in any case. Large files are left out of the search. */
async function holds(path: string, words: readonly string[]): Promise<boolean> {
  const info = await stat(path)
  if (info.size > MAX_SEARCH_FILE) return false
  const content = (await readFile(path, 'utf8')).toLowerCase()
  return words.every((word) => content.includes(word))
}

export function agentSessionRoutes(env: AgentEnvironment): readonly SceneRoute[] {
  const readerOf = (agent: string): SessionReader => {
    const reader = SESSION_READERS.find((candidate) => candidate.agent === agent)
    if (reader === undefined) refuse('unknown_agent', '还不能读这个 Agent 的会话记录。')
    return reader
  }
  return [
    {
      method: 'GET',
      path: '/agent-sessions',
      handle: async ({ query }) => {
        const asked = query.get('agent')
        const readers = asked === null || asked === '' ? SESSION_READERS : [readerOf(asked)]
        const limit = Math.min(Number.parseInt(query.get('limit') ?? '60', 10) || 60, 300)
        const words = (query.get('q') ?? '')
          .toLowerCase()
          .split(/\s+/)
          .filter((word) => word !== '')
          .slice(0, 8)
        const found = await Promise.all(
          readers.map(async (reader) => {
            const listed = await reader
              .list(env, words.length === 0 ? limit : Math.max(limit, 150))
              .catch(() => [])
            if (words.length === 0) return listed
            const matches: AgentSessionSummary[] = []
            for (const session of listed) {
              const label = `${session.title} ${session.project ?? ''}`.toLowerCase()
              if (words.every((word) => label.includes(word))) {
                matches.push(session)
                continue
              }
              const file = reader.file?.(env, session.id)
              if (file !== undefined && (await holds(file, words).catch(() => false)))
                matches.push(session)
              else if (reader.file === undefined) {
                const read = await reader.read(env, session.id).catch(() => undefined)
                const text =
                  read?.messages
                    .map((message) => message.text)
                    .join('\n')
                    .toLowerCase() ?? ''
                if (words.every((word) => text.includes(word))) matches.push(session)
              }
            }
            return matches
          }),
        )
        return {
          agents: SESSION_READERS.map((reader) => ({
            id: reader.agent,
            name: reader.name,
            found: existsSync(reader.root(env)),
          })),
          sessions: found
            .flat()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, limit),
        }
      },
    },
    {
      method: 'GET',
      path: '/agent-sessions/read',
      handle: async ({ query }) => {
        const reader = readerOf(required(query, 'agent'))
        const session = await reader.read(env, required(query, 'id')).catch(() => undefined)
        if (session === undefined)
          refuse('unknown_session', '找不到这个会话，可能已经被它的 Agent 删除了。')
        return { session }
      },
    },
  ]
}
