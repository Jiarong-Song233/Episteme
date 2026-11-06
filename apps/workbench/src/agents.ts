import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpActivity } from '@episteme/service'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import {
  checkManifest,
  loadPlugins,
  pluginDefinition,
  PluginRefused,
  type AgentPluginManifest,
  type PluginProblem,
} from './agent-plugins.js'

/**
 * The agents on this computer and their connection to the workbench.
 *
 * Each known agent says how to find it and where it keeps its MCP servers. Connecting prefers the agent's own
 * command (`claude mcp add …`), so the agent writes its own settings; otherwise only the `episteme` entry of its
 * settings file is changed, with comments and everything else left as they were, and the file as it was before the
 * first change is kept beside it. Nothing here gives an agent more than MCP already does: it reads and proposes, and
 * only the person confirms.
 */

export const SERVER_NAME = 'episteme'

/** How an agent's settings describe a server reached over HTTP, which differs from agent to agent. */
export type EntryStyle =
  | 'url'
  | 'httpUrl'
  | 'serverUrl'
  | 'type-http'
  | 'streamableHttp'
  | 'streamable-http'
  | 'opencode'
  | 'stdio'

export const ENTRY_STYLES: readonly EntryStyle[] = [
  'url',
  'httpUrl',
  'serverUrl',
  'type-http',
  'streamableHttp',
  'streamable-http',
  'opencode',
  'stdio',
]

/** Where in a settings file the servers are listed. */
export const SERVER_KEYS = ['mcpServers', 'servers', 'mcp', 'context_servers'] as const
export type ServerKey = (typeof SERVER_KEYS)[number]

export interface AgentEnvironment {
  readonly home: string
  readonly platform: NodeJS.Platform
  /** Where desktop programs keep their settings: `%APPDATA%`, `~/Library/Application Support` or `~/.config`. */
  readonly appData: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Runs an agent's command; resolves with whether it succeeded and what it printed. */
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ ok: boolean; output: string }>
  /** The program and script a client that only starts local servers runs to reach the workbench. */
  readonly bridge: { readonly command: string; readonly args: readonly string[] }
}

interface SettingsFile {
  readonly file: string
  readonly key: ServerKey
  readonly style: EntryStyle
}

export type AgentKind = 'cli' | 'editor' | 'desktop' | 'extension' | 'manager' | 'custom'
export const AGENT_KINDS: readonly AgentKind[] = [
  'cli',
  'editor',
  'desktop',
  'extension',
  'manager',
]

export interface AgentDefinition {
  readonly id: string
  readonly name: string
  readonly maker?: string
  readonly kind: AgentKind
  /** Commands on PATH that show it is installed; the first is the one that connects it. */
  readonly commands?: readonly string[]
  /** Files or folders whose presence shows it is installed. */
  readonly detect?: (env: AgentEnvironment) => readonly string[]
  /** Its MCP settings file, when it keeps one we can read and change. */
  readonly settings?: (env: AgentEnvironment) => SettingsFile
  /** Its own command for adding and removing a server. */
  readonly cli?: {
    readonly add: (url: string) => readonly string[]
    readonly remove: readonly string[]
  }
  /**
   * Whether it lists the server, for an agent whose settings we cannot safely write (TOML) or that keeps them where
   * only its own command reads them. Asked only when it is installed.
   */
  readonly listed?: (env: AgentEnvironment) => Promise<boolean | undefined>
  /**
   * For an agent without MCP settings but with skills: the folder of its skills. Connecting puts an `episteme`
   * skill there that tells it how to call the workbench with the command-line client.
   */
  readonly skill?: (env: AgentEnvironment) => string
  /**
   * A manager that writes the server into several agents: the plain address is given, so each agent is known by the
   * name it gives itself rather than by the manager's.
   */
  readonly untagged?: boolean
  /** Where the definition came from, when not from this file. */
  readonly source?: 'plugin'
  /** Said after connecting, such as that the program has to be restarted. */
  readonly after?: string
}

const restart = (name: string): string => `重启 ${name} 或开一个新会话后生效。`

/** `%LOCALAPPDATA%` on Windows, where some desktop programs keep their settings instead of `%APPDATA%`. */
export function localAppData(env: AgentEnvironment): string {
  return env.env['LOCALAPPDATA'] ?? join(env.home, 'AppData', 'Local')
}

/** The agents magpie writes into that Episteme cannot write itself (YAML, TOML or settings of its own). */
const MAGPIE_AGENTS = ['pi', 'hermes', 'openclaw', 'zcode', 'dsh'] as const

/** Whether a command's listing of MCP servers has the workbench's: a line that starts with its name. */
async function listedBy(
  env: AgentEnvironment,
  command: string,
  args: readonly string[],
  section?: RegExp,
): Promise<boolean | undefined> {
  const { ok, output } = await env.run(command, args)
  if (!ok) return undefined
  let text = output
  if (section !== undefined) {
    const start = text.search(section)
    if (start < 0) return false
    text = text.slice(start).split(/\r?\n/).slice(1).join('\n')
    // The section ends at the next line that is not indented.
    const end = text.search(/^\S/m)
    if (end >= 0) text = text.slice(0, end)
  }
  return new RegExp(`^\\s*${SERVER_NAME}(\\s|$)`, 'm').test(text)
}

const vscodeStorage = (env: AgentEnvironment, extension: string, file: string): string =>
  join(env.appData, 'Code', 'User', 'globalStorage', extension, 'settings', file)

export const KNOWN_AGENTS: readonly AgentDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    maker: 'Anthropic',
    kind: 'cli',
    commands: ['claude'],
    detect: (env) => [join(env.home, '.claude')],
    settings: (env) => ({
      file: join(env.home, '.claude.json'),
      key: 'mcpServers',
      style: 'type-http',
    }),
    cli: {
      add: (url) => ['mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER_NAME, url],
      remove: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
    },
    after: restart('Claude Code'),
  },
  {
    id: 'codex',
    name: 'Codex',
    maker: 'OpenAI',
    kind: 'cli',
    commands: ['codex'],
    detect: (env) => [codexHome(env)],
    cli: {
      add: (url) => ['mcp', 'add', SERVER_NAME, '--url', url],
      remove: ['mcp', 'remove', SERVER_NAME],
    },
    listed: async (env) => {
      const text = await readText(join(codexHome(env), 'config.toml'))
      if (text === undefined) return false
      return new RegExp(`^\\s*\\[mcp_servers\\.("?)${SERVER_NAME}\\1\\]`, 'm').test(text)
    },
    after: restart('Codex'),
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    maker: 'Google',
    kind: 'cli',
    commands: ['gemini'],
    detect: (env) => [join(env.home, '.gemini')],
    settings: (env) => ({
      file: join(env.home, '.gemini', 'settings.json'),
      key: 'mcpServers',
      style: 'httpUrl',
    }),
    cli: {
      add: (url) => ['mcp', 'add', '--scope', 'user', '--transport', 'http', SERVER_NAME, url],
      remove: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
    },
    after: restart('Gemini CLI'),
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    maker: '阿里通义',
    kind: 'cli',
    commands: ['qwen'],
    detect: (env) => [join(env.home, '.qwen')],
    settings: (env) => ({
      file: join(env.home, '.qwen', 'settings.json'),
      key: 'mcpServers',
      style: 'httpUrl',
    }),
    cli: {
      add: (url) => ['mcp', 'add', '--scope', 'user', '--transport', 'http', SERVER_NAME, url],
      remove: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
    },
    after: restart('Qwen Code'),
  },
  {
    id: 'kimi-cli',
    name: 'Kimi CLI',
    maker: '月之暗面',
    kind: 'cli',
    commands: ['kimi'],
    detect: (env) => [join(env.home, '.kimi')],
    settings: (env) => ({
      file: join(env.home, '.kimi', 'mcp.json'),
      key: 'mcpServers',
      style: 'url',
    }),
    cli: {
      add: (url) => ['mcp', 'add', '--transport', 'http', SERVER_NAME, url],
      remove: ['mcp', 'remove', SERVER_NAME],
    },
    after: restart('Kimi CLI'),
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    maker: '腾讯',
    kind: 'cli',
    commands: ['codebuddy'],
    cli: {
      add: (url) => ['mcp', 'add', '--scope', 'user', '--transport', 'http', SERVER_NAME, url],
      remove: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
    },
    after: restart('CodeBuddy'),
  },
  {
    id: 'opencode',
    name: 'opencode',
    kind: 'cli',
    commands: ['opencode'],
    detect: (env) => [join(env.home, '.config', 'opencode')],
    settings: (env) => {
      const folder = join(env.home, '.config', 'opencode')
      const jsonc = join(folder, 'opencode.jsonc')
      return {
        file: existsSync(jsonc) ? jsonc : join(folder, 'opencode.json'),
        key: 'mcp',
        style: 'opencode',
      }
    },
    after: restart('opencode'),
  },
  {
    id: 'trae',
    name: 'Trae',
    maker: '字节跳动',
    kind: 'editor',
    commands: ['trae'],
    detect: (env) => [join(env.appData, 'Trae')],
    settings: (env) => ({
      file: join(env.appData, 'Trae', 'User', 'mcp.json'),
      key: 'mcpServers',
      style: 'url',
    }),
    after: restart('Trae'),
  },
  {
    id: 'trae-cn',
    name: 'Trae CN',
    maker: '字节跳动',
    kind: 'editor',
    detect: (env) => [join(env.appData, 'Trae CN')],
    settings: (env) => ({
      file: join(env.appData, 'Trae CN', 'User', 'mcp.json'),
      key: 'mcpServers',
      style: 'url',
    }),
    after: restart('Trae CN'),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'editor',
    commands: ['cursor'],
    detect: (env) => [join(env.home, '.cursor'), join(env.appData, 'Cursor')],
    settings: (env) => ({
      file: join(env.home, '.cursor', 'mcp.json'),
      key: 'mcpServers',
      style: 'url',
    }),
    after: '在 Cursor 的 MCP 设置里确认 episteme 已打开。',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    maker: 'Microsoft',
    kind: 'editor',
    commands: ['code'],
    detect: (env) => [join(env.appData, 'Code')],
    settings: (env) => ({
      file: join(env.appData, 'Code', 'User', 'mcp.json'),
      key: 'servers',
      style: 'type-http',
    }),
    after: '在 VS Code 的 Copilot 对话里选“代理”模式后可用。',
  },
  {
    id: 'cline',
    name: 'Cline',
    kind: 'extension',
    detect: (env) => [join(env.appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')],
    settings: (env) => ({
      file: vscodeStorage(env, 'saoudrizwan.claude-dev', 'cline_mcp_settings.json'),
      key: 'mcpServers',
      style: 'streamableHttp',
    }),
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    kind: 'extension',
    detect: (env) => [
      join(env.appData, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'),
    ],
    settings: (env) => ({
      file: vscodeStorage(env, 'rooveterinaryinc.roo-cline', 'mcp_settings.json'),
      key: 'mcpServers',
      style: 'streamable-http',
    }),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    kind: 'editor',
    commands: ['windsurf'],
    detect: (env) => [join(env.home, '.codeium', 'windsurf'), join(env.appData, 'Windsurf')],
    settings: (env) => ({
      file: join(env.home, '.codeium', 'windsurf', 'mcp_config.json'),
      key: 'mcpServers',
      style: 'serverUrl',
    }),
    after: restart('Windsurf'),
  },
  {
    id: 'kiro',
    name: 'Kiro',
    maker: 'Amazon',
    kind: 'editor',
    commands: ['kiro'],
    detect: (env) => [join(env.home, '.kiro'), join(env.appData, 'Kiro')],
    settings: (env) => ({
      file: join(env.home, '.kiro', 'settings', 'mcp.json'),
      key: 'mcpServers',
      style: 'url',
    }),
  },
  {
    id: 'zed',
    name: 'Zed',
    kind: 'editor',
    commands: ['zed'],
    detect: (env) => [zedFolder(env)],
    settings: (env) => ({
      file: join(zedFolder(env), 'settings.json'),
      key: 'context_servers',
      style: 'url',
    }),
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    maker: 'Anthropic',
    kind: 'desktop',
    detect: (env) => [join(env.appData, 'Claude'), ...claudeDesktopLocal(env)],
    settings: (env) => ({
      // The Store version on Windows keeps its settings under %LOCALAPPDATA%; the installer version under %APPDATA%.
      file: join(
        claudeDesktopLocal(env).find((folder) =>
          existsSync(join(folder, 'claude_desktop_config.json')),
        ) ?? join(env.appData, 'Claude'),
        'claude_desktop_config.json',
      ),
      key: 'mcpServers',
      // Its settings file only starts local servers, so it runs a small relay to the workbench.
      style: 'stdio',
    }),
    after: '完全退出 Claude Desktop（托盘里也退出）再打开后生效。',
  },
  {
    id: 'antigravity-cli',
    name: 'Antigravity CLI',
    maker: 'Google',
    kind: 'cli',
    commands: ['agy'],
    detect: (env) => [join(env.home, '.gemini', 'antigravity-cli')],
    cli: {
      add: (url) => ['mcp', 'add', '--type', 'http', SERVER_NAME, url],
      remove: ['mcp', 'remove', SERVER_NAME],
    },
    // It keeps its servers where only its own command reads them.
    listed: (env) => listedBy(env, 'agy', ['mcp', 'list']),
    after: '新开一个 agy 会话后生效。',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    maker: 'Google',
    kind: 'editor',
    commands: ['antigravity'],
    detect: (env) => [join(env.appData, 'Antigravity'), join(env.home, '.gemini', 'antigravity')],
    settings: (env) => ({
      file: join(env.home, '.gemini', 'antigravity', 'mcp_config.json'),
      key: 'mcpServers',
      style: 'serverUrl',
    }),
    after: '在 Antigravity 的 MCP 服务器页里点“刷新”，或重启后生效。',
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    maker: '腾讯',
    kind: 'desktop',
    detect: (env) => [join(env.home, '.workbuddy')],
    settings: (env) => ({
      file: join(env.home, '.workbuddy', 'mcp.json'),
      key: 'mcpServers',
      style: 'type-http',
    }),
    after: restart('WorkBuddy'),
  },
  {
    id: 'qoder',
    name: 'Qoder',
    maker: '阿里巴巴',
    kind: 'editor',
    commands: ['qoder'],
    detect: (env) => [join(env.home, '.qoder')],
    settings: (env) => ({
      file: join(env.home, '.qoder', 'settings.json'),
      key: 'mcpServers',
      style: 'type-http',
    }),
    after: restart('Qoder'),
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    maker: '阿里巴巴',
    kind: 'editor',
    detect: (env) => [join(env.home, '.qoder-cn')],
    settings: (env) => ({
      file: join(env.home, '.qoder-cn', 'settings.json'),
      key: 'mcpServers',
      style: 'type-http',
    }),
    after: restart('Qoder CN'),
  },
  {
    id: 'doubao-work',
    name: '豆包工作',
    maker: '字节跳动',
    kind: 'desktop',
    detect: (env) => [doubaoWorkFolder(env)],
    // It has no MCP settings it reads from a file; it reads skills, and its agent can run commands.
    skill: (env) =>
      join(
        doubaoWorkFolder(env),
        'User Data',
        'Default',
        '.doubaowork',
        'agent_mode',
        'workspace',
        '.skills',
      ),
    after: '在豆包工作的“技能”里能看到 episteme；新开一个任务后生效。',
  },
  {
    id: 'magpie',
    name: 'magpie（Pi、Hermes、OpenClaw、ZCode、DeepSeek Harness）',
    kind: 'manager',
    commands: ['magpie'],
    untagged: true,
    cli: {
      add: (url) => [
        'library',
        'mcp',
        'add',
        SERVER_NAME,
        url,
        `agents=${MAGPIE_AGENTS.join(',')}`,
      ],
      remove: ['library', 'mcp', 'rm', SERVER_NAME],
    },
    listed: (env) => listedBy(env, 'magpie', ['library'], /^MCP servers/m),
    after: 'magpie 会把它写进这几个 Agent；在 magpie 的“库”页可以改给哪些 Agent。',
  },
]

function claudeDesktopLocal(env: AgentEnvironment): string[] {
  return env.platform === 'win32' ? [join(localAppData(env), 'Claude')] : []
}

function doubaoWorkFolder(env: AgentEnvironment): string {
  return env.platform === 'win32'
    ? join(localAppData(env), 'DoubaoWork')
    : join(env.appData, 'DoubaoWork')
}

function codexHome(env: AgentEnvironment): string {
  return env.env['CODEX_HOME'] ?? join(env.home, '.codex')
}

function zedFolder(env: AgentEnvironment): string {
  return env.platform === 'win32' ? join(env.appData, 'Zed') : join(env.home, '.config', 'zed')
}

/** The address an agent is given: the workbench's, tagged with the agent, so its calls can be told apart. */
export function addressFor(mcpUrl: string, id: string): string {
  const url = new URL(mcpUrl)
  url.searchParams.set('client', id)
  return url.toString()
}

/** The entry for the workbench in an agent's settings, written in that agent's way. */
export function entryOf(
  style: EntryStyle,
  url: string,
  bridge: AgentEnvironment['bridge'],
): Record<string, unknown> {
  switch (style) {
    case 'url':
      return { url }
    case 'httpUrl':
      return { httpUrl: url }
    case 'serverUrl':
      return { serverUrl: url }
    case 'type-http':
      return { type: 'http', url }
    case 'streamableHttp':
      return { type: 'streamableHttp', url, disabled: false }
    case 'streamable-http':
      return { type: 'streamable-http', url }
    case 'opencode':
      return { type: 'remote', url, enabled: true }
    case 'stdio':
      return { command: bridge.command, args: [...bridge.args, url] }
  }
}

/** The address an entry points at, whatever its style. */
function urlOfEntry(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  for (const key of ['url', 'httpUrl', 'serverUrl']) {
    if (typeof record[key] === 'string') return record[key]
  }
  const args = record['args']
  if (Array.isArray(args)) {
    const last: unknown = args[args.length - 1]
    if (typeof last === 'string' && /^https?:\/\//.test(last)) return last
  }
  return undefined
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}

export class AgentFailure extends Error {
  constructor(
    readonly code:
      | 'unknown_agent'
      | 'not_installed'
      | 'cannot_connect'
      | 'unreadable_settings'
      | 'invalid_request',
    message: string,
  ) {
    super(message)
    this.name = 'AgentFailure'
  }
}

/** What a settings file says about the workbench's entry. A file that is not JSON is refused, never rewritten. */
async function entryIn(
  target: SettingsFile,
): Promise<{ text: string | undefined; entry: unknown }> {
  const text = await readText(target.file)
  if (text === undefined || text.trim() === '') return { text, entry: undefined }
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true }) as unknown
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AgentFailure(
      'unreadable_settings',
      `${target.file} 不是能读懂的 JSON，没有改动它。请先修好这个文件，或者手动加入。`,
    )
  }
  const servers = (parsed as Record<string, unknown>)[target.key]
  const entry =
    typeof servers === 'object' && servers !== null
      ? (servers as Record<string, unknown>)[SERVER_NAME]
      : undefined
  return { text, entry }
}

/**
 * Sets or removes the workbench's entry, and nothing else: other servers, settings, comments and layout stay as
 * they are. The file as it was before Episteme first changed it is kept beside it, and the write replaces the
 * file in one step, so an agent never reads half of it.
 */
async function writeEntry(
  target: SettingsFile,
  entry: Record<string, unknown> | undefined,
): Promise<void> {
  const { text } = await entryIn(target)
  if (text === undefined && entry === undefined) return
  const before = text ?? ''
  const base = before.trim() === '' ? '{}' : before
  const formatting = { insertSpaces: true, tabSize: 2, eol: base.includes('\r\n') ? '\r\n' : '\n' }
  const after = applyEdits(
    base,
    modify(base, [target.key, SERVER_NAME], entry, { formattingOptions: formatting }),
  )
  await mkdir(dirname(target.file), { recursive: true })
  const kept = `${target.file}.before-episteme`
  if (text !== undefined && !existsSync(kept)) await copyFile(target.file, kept)
  const temporary = `${target.file}.episteme-${process.pid}.tmp`
  await writeFile(temporary, after.endsWith('\n') ? after : `${after}\n`)
  await rename(temporary, target.file)
}

function onPath(command: string, env: AgentEnvironment): boolean {
  const folders = (env.env['PATH'] ?? env.env['Path'] ?? '')
    .split(delimiter)
    .filter((folder) => folder !== '')
  const extensions =
    env.platform === 'win32'
      ? (env.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((extension) => extension !== '')
      : ['']
  return folders.some((folder) =>
    extensions.some((extension) => {
      try {
        return statSync(join(folder, command + extension)).isFile()
      } catch {
        return false
      }
    }),
  )
}

export interface CustomAgent {
  readonly id: string
  readonly name: string
  /** Its settings file; without one, the person copies the address into the agent themselves. */
  readonly file?: string
  readonly key?: ServerKey
  readonly style?: EntryStyle
}

/** One client seen at the MCP endpoint, as it describes itself. */
export interface AgentUse {
  readonly key: string
  /** The agent it is, when its address or its own name says so. */
  readonly agent?: string
  readonly name: string
  readonly version?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly calls: number
  readonly lastTool?: string
}

interface AgentsFile {
  readonly custom: readonly CustomAgent[]
  readonly uses: readonly AgentUse[]
}

/** Names agents give themselves at `initialize`, for a client connected without the tagged address. */
const SELF_NAMES: readonly (readonly [RegExp, string])[] = [
  [/antigravity[-_ ]?cli|\bagy\b/i, 'antigravity-cli'],
  [/antigravity/i, 'antigravity'],
  [/workbuddy/i, 'workbuddy'],
  [/qoder/i, 'qoder-cn'],
  [/doubao|豆包/i, 'doubao-work'],
  [/claude[-_ ]?code/i, 'claude-code'],
  [/codex/i, 'codex'],
  [/gemini/i, 'gemini-cli'],
  [/qwen/i, 'qwen-code'],
  [/kimi/i, 'kimi-cli'],
  [/codebuddy/i, 'codebuddy'],
  [/opencode/i, 'opencode'],
  [/trae/i, 'trae'],
  [/cursor/i, 'cursor'],
  [/visual studio code|vscode/i, 'vscode'],
  [/cline/i, 'cline'],
  [/roo/i, 'roo-code'],
  [/windsurf/i, 'windsurf'],
  [/kiro/i, 'kiro'],
  [/zed/i, 'zed'],
  [/claude[-_ ]?ai|claude desktop/i, 'claude-desktop'],
]

export interface AgentView {
  readonly id: string
  readonly name: string
  readonly maker?: string
  readonly kind: AgentDefinition['kind']
  readonly installed: boolean
  /** `undefined` when its settings cannot be read to tell. */
  readonly connected: boolean | undefined
  /** Whether the entry points at this workbench's current address. */
  readonly current?: boolean
  /** How connecting works: its own command, its settings file, a skill, or copying the address by hand. */
  readonly how: 'command' | 'settings' | 'skill' | 'manual'
  readonly file?: string
  readonly source?: 'plugin'
  readonly address: string
  readonly after?: string
  readonly use?: AgentUse
}

/**
 * The agents of this computer: which are installed, which are connected, and which have called the workbench.
 *
 * Custom agents and what has been seen are kept in a small file beside the graph.
 */
export class Agents {
  readonly #file: string
  readonly #env: AgentEnvironment
  readonly #mcpUrl: () => string
  #custom: CustomAgent[]
  #plugins: AgentDefinition[] = []
  #problems: PluginProblem[] = []
  /** What an agent's own command last said about whether it lists the workbench: asking takes a second or two. */
  readonly #listedCache = new Map<string, { at: number; value: boolean | undefined }>()
  readonly #uses = new Map<string, AgentUse>()
  /** A client's user agent, once its `initialize` said who it is: later calls carry no name. */
  readonly #namesByUserAgent = new Map<string, { name: string; version?: string }>()
  #saving: ReturnType<typeof setTimeout> | undefined
  #writes: Promise<unknown> = Promise.resolve()

  private constructor(
    file: string,
    env: AgentEnvironment,
    mcpUrl: () => string,
    saved: AgentsFile,
  ) {
    this.#file = file
    this.#env = env
    this.#mcpUrl = mcpUrl
    this.#custom = [...saved.custom]
    for (const use of saved.uses) this.#uses.set(use.key, use)
  }

  /** `mcpUrl` gives the workbench's MCP address once the service has started. A damaged file is set aside. */
  static async open(file: string, env: AgentEnvironment, mcpUrl: () => string): Promise<Agents> {
    let saved: AgentsFile = { custom: [], uses: [] }
    try {
      const parsed = JSON.parse((await readText(file)) ?? '{}') as Partial<AgentsFile>
      saved = {
        custom: Array.isArray(parsed.custom) ? parsed.custom.filter(isCustomAgent) : [],
        uses: Array.isArray(parsed.uses) ? parsed.uses.filter(isUse) : [],
      }
    } catch {
      // Unreadable: start over. What it held was a list and a history, nothing the person cannot redo.
    }
    const agents = new Agents(file, env, mcpUrl, saved)
    await agents.#loadPlugins()
    return agents
  }

  /** The folder of agent plugins, beside the graph. */
  get pluginFolder(): string {
    return join(dirname(this.#file), 'agent-plugins')
  }

  async #loadPlugins(): Promise<void> {
    const { definitions, problems } = await loadPlugins(
      this.pluginFolder,
      this.#env,
      new Set(KNOWN_AGENTS.map((definition) => definition.id)),
    )
    this.#plugins = definitions
    this.#problems = problems
  }

  #definitions(): AgentDefinition[] {
    return [
      ...KNOWN_AGENTS,
      ...this.#plugins,
      ...this.#custom.map(
        (custom): AgentDefinition => ({
          id: custom.id,
          name: custom.name,
          kind: 'custom',
          ...(custom.file === undefined
            ? {}
            : {
                detect: () => [custom.file!],
                settings: () => ({
                  file: custom.file!,
                  key: custom.key ?? 'mcpServers',
                  style: custom.style ?? 'url',
                }),
              }),
        }),
      ),
    ]
  }

  #definition(id: string): AgentDefinition {
    const found = this.#definitions().find((definition) => definition.id === id)
    if (found === undefined) throw new AgentFailure('unknown_agent', '没有这个 Agent。')
    return found
  }

  #installed(definition: AgentDefinition): boolean {
    if (definition.kind === 'custom') return true
    if (definition.commands?.some((command) => onPath(command, this.#env)) === true) return true
    return definition.detect?.(this.#env).some((path) => existsSync(path)) === true
  }

  #how(definition: AgentDefinition): AgentView['how'] {
    const command = definition.commands?.[0]
    if (definition.cli !== undefined && command !== undefined && onPath(command, this.#env))
      return 'command'
    if (definition.settings !== undefined) return 'settings'
    if (definition.skill !== undefined) return 'skill'
    return 'manual'
  }

  #address(definition: AgentDefinition): string {
    return definition.untagged === true ? this.#mcpUrl() : addressFor(this.#mcpUrl(), definition.id)
  }

  async #listed(definition: AgentDefinition): Promise<boolean | undefined> {
    const cached = this.#listedCache.get(definition.id)
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.value
    const value = await definition.listed!(this.#env).catch(() => undefined)
    this.#listedCache.set(definition.id, { at: Date.now(), value })
    return value
  }

  async #view(definition: AgentDefinition): Promise<AgentView> {
    const address = this.#address(definition)
    const installed = this.#installed(definition)
    let connected: boolean | undefined
    let current: boolean | undefined
    let file: string | undefined
    const target = definition.settings?.(this.#env)
    if (target !== undefined) {
      file = target.file
      try {
        const { entry } = await entryIn(target)
        connected = entry !== undefined
        if (connected) current = urlOfEntry(entry) === address
      } catch {
        connected = undefined
      }
    } else if (definition.listed !== undefined) {
      connected = installed ? await this.#listed(definition) : false
    } else if (definition.skill !== undefined) {
      file = skillFile(definition.skill(this.#env))
      const text = await readText(file).catch(() => undefined)
      connected = text?.includes(SKILL_MARK) === true
      if (connected) current = text!.includes(address)
    }
    const use = [...this.#uses.values()]
      .filter((candidate) => candidate.agent === definition.id)
      .sort((a, b) => b.lastSeen - a.lastSeen)[0]
    return {
      id: definition.id,
      name: definition.name,
      ...(definition.maker === undefined ? {} : { maker: definition.maker }),
      kind: definition.kind,
      installed,
      connected,
      ...(current === undefined ? {} : { current }),
      how: this.#how(definition),
      ...(file === undefined ? {} : { file }),
      ...(definition.source === undefined ? {} : { source: definition.source }),
      address,
      ...(definition.after === undefined ? {} : { after: definition.after }),
      ...(use === undefined ? {} : { use }),
    }
  }

  /** Every known agent and every custom one, installed ones first; and clients seen that match none of them. */
  async list(): Promise<{
    agents: AgentView[]
    others: AgentUse[]
    plugins: { folder: string; problems: PluginProblem[] }
  }> {
    // A plugin dropped into the folder, or taken out, shows the next time the list is asked for.
    await this.#loadPlugins()
    const agents = await Promise.all(
      this.#definitions().map((definition) => this.#view(definition)),
    )
    agents.sort((a, b) => Number(b.installed) - Number(a.installed))
    const ids = new Set(agents.map((agent) => agent.id))
    const others = [...this.#uses.values()]
      .filter((use) => use.agent === undefined || !ids.has(use.agent))
      .sort((a, b) => b.lastSeen - a.lastSeen)
    return { agents, others, plugins: { folder: this.pluginFolder, problems: this.#problems } }
  }

  /** Connects one agent, with its own command when it has one, else through its settings file or a skill. */
  async connect(id: string): Promise<{ agent: AgentView; said?: string }> {
    const definition = this.#definition(id)
    if (!this.#installed(definition)) {
      throw new AgentFailure('not_installed', `这台电脑上没有找到 ${definition.name}。`)
    }
    this.#listedCache.delete(definition.id)
    const address = this.#address(definition)
    const target = definition.settings?.(this.#env)
    let said: string | undefined
    if (this.#how(definition) === 'skill') {
      const folder = join(definition.skill!(this.#env), SERVER_NAME)
      await this.#serialized(async () => {
        await mkdir(folder, { recursive: true })
        await writeFile(join(folder, 'SKILL.md'), skillText(address, cliOf(this.#env)))
      })
      return { agent: await this.#view(definition) }
    }
    if (this.#how(definition) === 'command') {
      const command = definition.commands![0]!
      // Adding refuses a name that is already there, so an old entry, at another address, goes first.
      await this.#env.run(command, definition.cli!.remove)
      const added = await this.#env.run(command, definition.cli!.add(address))
      if (added.ok) return { agent: await this.#view(definition) }
      said = lastLines(added.output)
      if (target === undefined) {
        throw new AgentFailure('cannot_connect', `${definition.name} 没有接受：${said}`)
      }
    }
    if (target === undefined) {
      throw new AgentFailure(
        'cannot_connect',
        `${definition.name} 需要手动加入，请复制下面的地址。`,
      )
    }
    await this.#serialized(() =>
      writeEntry(target, entryOf(target.style, address, this.#env.bridge)),
    )
    return { agent: await this.#view(definition), ...(said === undefined ? {} : { said }) }
  }

  /** Removes the workbench from one agent's settings. Its other servers and settings stay. */
  async disconnect(id: string): Promise<{ agent: AgentView }> {
    const definition = this.#definition(id)
    this.#listedCache.delete(definition.id)
    const target = definition.settings?.(this.#env)
    if (this.#how(definition) === 'skill') {
      const file = skillFile(definition.skill!(this.#env))
      // Only a skill Episteme wrote is taken away: one the person wrote with the same name stays.
      const text = await readText(file)
      if (text?.includes(SKILL_MARK) === true) {
        await this.#serialized(() => rm(dirname(file), { recursive: true, force: true }))
      }
      return { agent: await this.#view(definition) }
    }
    if (this.#how(definition) === 'command') {
      const removed = await this.#env.run(definition.commands![0]!, definition.cli!.remove)
      if (removed.ok || target === undefined) return { agent: await this.#view(definition) }
    }
    if (target === undefined) {
      throw new AgentFailure(
        'cannot_connect',
        `${definition.name} 需要在它自己的设置里删除 episteme。`,
      )
    }
    await this.#serialized(() => writeEntry(target, undefined))
    return { agent: await this.#view(definition) }
  }

  /** Adds an agent the list does not know, such as one the person wrote. */
  async addCustom(next: Omit<CustomAgent, 'id'>): Promise<{ agent: AgentView }> {
    const name = next.name.trim()
    if (name === '' || name.length > 60)
      throw new AgentFailure('invalid_request', '名字要有 1 到 60 个字。')
    if (next.file !== undefined) {
      if (!isAbsolute(next.file) || !/\.jsonc?$/i.test(next.file)) {
        throw new AgentFailure(
          'invalid_request',
          '配置文件要写完整路径，并且是 .json 或 .jsonc 文件。',
        )
      }
      if (next.key !== undefined && !SERVER_KEYS.includes(next.key)) {
        throw new AgentFailure('invalid_request', '不认识这个列表名。')
      }
      if (next.style !== undefined && !ENTRY_STYLES.includes(next.style)) {
        throw new AgentFailure('invalid_request', '不认识这种写法。')
      }
    }
    const custom: CustomAgent = {
      id: `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      ...(next.file === undefined
        ? {}
        : { file: next.file, key: next.key ?? 'mcpServers', style: next.style ?? 'url' }),
    }
    this.#custom = [...this.#custom, custom]
    await this.#save()
    return { agent: await this.#view(this.#definition(custom.id)) }
  }

  /** Forgets a custom agent. Its settings file is left as it is: disconnect it first to remove the entry. */
  async removeCustom(id: string): Promise<void> {
    if (!this.#custom.some((custom) => custom.id === id)) {
      throw new AgentFailure('unknown_agent', '没有这个自定义 Agent。')
    }
    this.#custom = this.#custom.filter((custom) => custom.id !== id)
    await this.#save()
  }

  /** Keeps a plugin the person gave, as `<id>.json` in the plugin folder, once it is checked. */
  async importPlugin(text: string): Promise<{ agent: AgentView }> {
    const errors: ParseError[] = []
    const parsed = parse(text, errors, { allowTrailingComma: true }) as unknown
    if (errors.length > 0) throw new AgentFailure('invalid_request', '插件不是能读懂的 JSON。')
    let manifest: AgentPluginManifest
    try {
      manifest = checkManifest(parsed, new Set(KNOWN_AGENTS.map((definition) => definition.id)))
      pluginDefinition(manifest, this.#env)
    } catch (error) {
      if (error instanceof PluginRefused) throw new AgentFailure('invalid_request', error.message)
      throw error
    }
    await this.#serialized(async () => {
      await mkdir(this.pluginFolder, { recursive: true })
      await writeFile(
        join(this.pluginFolder, `${manifest.id}.json`),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
    })
    await this.#loadPlugins()
    return { agent: await this.#view(this.#definition(manifest.id)) }
  }

  /** Takes a plugin out of the folder. The agent's settings stay as they are: disconnect it first for that. */
  async removePlugin(id: string): Promise<void> {
    if (!this.#plugins.some((plugin) => plugin.id === id)) {
      throw new AgentFailure('unknown_agent', '没有这个插件。')
    }
    const file = join(this.pluginFolder, `${id}.json`)
    if (!existsSync(file)) {
      throw new AgentFailure(
        'invalid_request',
        `这个插件不在 ${id}.json 里，请到 ${this.pluginFolder} 里自己删掉它的文件。`,
      )
    }
    await this.#serialized(() => rm(file))
    await this.#loadPlugins()
  }

  /** Notes one MCP message: who sent it, as far as it says, and when. */
  note(activity: McpActivity): void {
    const userAgent = activity.userAgent ?? ''
    const ids = new Set(this.#definitions().map((definition) => definition.id))
    const tagged =
      activity.client !== undefined && ids.has(activity.client) ? activity.client : undefined
    // A client on its own address is known by it. Only one without falls back to its user agent, which several
    // clients built on the same library may share.
    if (tagged === undefined && activity.clientInfo !== undefined && userAgent !== '') {
      this.#namesByUserAgent.set(userAgent, activity.clientInfo)
    }
    const told =
      activity.clientInfo ??
      (tagged === undefined ? this.#namesByUserAgent.get(userAgent) : undefined)
    const named =
      tagged ?? SELF_NAMES.find(([pattern]) => pattern.test(told?.name ?? userAgent))?.[1]
    const key =
      tagged ?? (told === undefined ? `ua:${userAgent || 'unknown'}` : `name:${told.name}`)
    const known = this.#uses.get(key)
    const definition =
      named === undefined ? undefined : this.#definitions().find((d) => d.id === named)
    this.#uses.set(key, {
      key,
      ...(named === undefined ? {} : { agent: named }),
      name:
        told?.name ??
        known?.name ??
        definition?.name ??
        (userAgent === '' ? '未知客户端' : userAgent),
      ...((told?.version ?? known?.version) === undefined
        ? {}
        : { version: (told?.version ?? known?.version)! }),
      firstSeen: known?.firstSeen ?? activity.at,
      lastSeen: activity.at,
      calls: (known?.calls ?? 0) + (activity.method === 'tools/call' ? 1 : 0),
      ...(activity.tool === undefined
        ? known?.lastTool === undefined
          ? {}
          : { lastTool: known.lastTool }
        : { lastTool: activity.tool }),
    })
    // Kept a few seconds later, so a burst of calls is one write.
    if (this.#saving === undefined) {
      this.#saving = setTimeout(() => {
        this.#saving = undefined
        void this.#save().catch(() => undefined)
      }, 3_000)
      this.#saving.unref?.()
    }
  }

  /** Forgets what was seen of one client. */
  async forget(key: string): Promise<void> {
    this.#uses.delete(key)
    await this.#save()
  }

  /** Writes what is pending now, as on stopping. */
  async flush(): Promise<void> {
    if (this.#saving !== undefined) clearTimeout(this.#saving)
    this.#saving = undefined
    await this.#save()
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(work)
    this.#writes = run.catch(() => undefined)
    return run
  }

  #save(): Promise<void> {
    return this.#serialized(async () => {
      const file: AgentsFile = { custom: this.#custom, uses: [...this.#uses.values()].slice(-200) }
      await mkdir(dirname(this.#file), { recursive: true })
      const temporary = `${this.#file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.#file)
    })
  }
}

/** In every skill Episteme writes, so it never takes away one it did not write. */
const SKILL_MARK = '<!-- written by the Episteme workbench -->'

function skillFile(folder: string): string {
  return join(folder, SERVER_NAME, 'SKILL.md')
}

/** The command-line client beside the relay. */
function cliOf(env: AgentEnvironment): { command: string; script: string } {
  const relay = env.bridge.args[0] ?? 'mcp-bridge.js'
  return { command: env.bridge.command, script: join(dirname(relay), 'episteme-cli.js') }
}

/** The skill for an agent that runs commands but reads no MCP settings. */
export function skillText(address: string, cli: { command: string; script: string }): string {
  const run = `"${cli.command}" "${cli.script}" --url "${address}"`
  return `---
name: episteme
description: 查询和记录这个人在 Episteme 里的理解。回答学习相关的问题前先用它找出这个人已经懂了什么；对话里出现值得记下的理解时，用它提出候选，由本人自己确认。
---

${SKILL_MARK}

# Episteme 工作台

Episteme 记着这个人自己确认过的理解。你通过下面的命令调用它的工具；命令只访问这台电脑上的工作台（${address}）。

列出全部工具和参数：

\`\`\`
${run} tools
\`\`\`

调用一个工具，参数是一个 JSON 对象；参数长或含引号时，用 \`-\` 从标准输入读：

\`\`\`
${run} call recall "{\\"question\\": \\"贝叶斯定理\\"}"
echo {"kind":"claim","label":"…","rationale":"…"} | ${run} call propose -
\`\`\`

## 规则

- 回答前先 \`recall\`，看这个人已经懂了什么、记过什么。
- 你只能提出候选（\`propose\`、\`distill\`），不能替这个人确认理解：候选会进入他的审阅队列，由他本人决定。
- 不要说“你已经掌握了”。把对话交给 \`thread_open\` / \`thread_append\` 保存时，学生的话要原样记下。
- 工作台没开时命令会说连不上，请这个人先打开 Episteme。
`
}

function lastLines(output: string): string {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
  return lines.slice(-3).join(' ').slice(0, 300) || '没有说明原因'
}

function isCustomAgent(value: unknown): value is CustomAgent {
  const record = value as Partial<CustomAgent> | null
  return (
    typeof record?.id === 'string' &&
    record.id.startsWith('custom-') &&
    typeof record.name === 'string'
  )
}

function isUse(value: unknown): value is AgentUse {
  const record = value as Partial<AgentUse> | null
  return (
    typeof record?.key === 'string' &&
    typeof record.name === 'string' &&
    typeof record.lastSeen === 'number' &&
    typeof record.firstSeen === 'number' &&
    typeof record.calls === 'number'
  )
}

/** This computer, as the running workbench sees it. */
export function localAgentEnvironment(): AgentEnvironment {
  const home = homedir()
  const platform = process.platform
  const appData =
    platform === 'win32'
      ? (process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'))
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'))
  return {
    home,
    platform,
    appData,
    env: process.env,
    run: (command, args) =>
      new Promise((resolve) => {
        execFile(
          command,
          args,
          // Windows finds `claude.cmd` and the like only through the shell. Every argument here is ours: a fixed
          // word or the workbench's own address, never anything a request said.
          { shell: platform === 'win32', timeout: 60_000, windowsHide: true, encoding: 'utf8' },
          (error, stdout, stderr) =>
            resolve({ ok: error === null, output: `${stdout}\n${stderr}` }),
        )
      }),
    bridge: {
      command: process.execPath,
      args: [join(dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.js')],
    },
  }
}
