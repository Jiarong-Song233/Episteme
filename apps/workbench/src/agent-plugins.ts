import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import {
  AGENT_KINDS,
  ENTRY_STYLES,
  SERVER_KEYS,
  localAppData,
  type AgentDefinition,
  type AgentEnvironment,
  type AgentKind,
  type EntryStyle,
  type ServerKey,
} from './agents.js'

/**
 * Agent plugins: a JSON file per agent, in the `agent-plugins` folder beside the graph, describing an agent the
 * built-in list does not know: how to find it, and where it keeps its MCP servers, its command for adding one, or its
 * skills folder. A plugin only describes; connecting it does the same as for a built-in agent, so a plugin can
 * neither run anything but the agent's own command with fixed words and the workbench's address, nor write anything
 * but the `episteme` entry or skill.
 *
 *   {
 *     "id": "my-agent", "name": "我的 Agent", "maker": "…", "kind": "desktop",
 *     "detect": ["~/.my-agent"], "commands": ["my-agent"],
 *     "settings": { "file": "~/.my-agent/mcp.json", "key": "mcpServers", "style": "type-http" },
 *     "cli": { "add": ["mcp", "add", "episteme", "{url}"], "remove": ["mcp", "remove", "episteme"], "list": ["mcp", "list"] },
 *     "skills": "~/.my-agent/skills",
 *     "after": "重启后生效。"
 *   }
 *
 * Paths start with `~`, `{home}`, `{appData}` or `{localAppData}`, or are absolute.
 */

export interface AgentPluginManifest {
  readonly id: string
  readonly name: string
  readonly maker?: string
  readonly kind?: Exclude<AgentKind, 'custom'>
  readonly detect?: readonly string[]
  readonly commands?: readonly string[]
  readonly settings?: {
    readonly file: string
    readonly key?: ServerKey
    readonly style?: EntryStyle
  }
  readonly cli?: {
    readonly add: readonly string[]
    readonly remove: readonly string[]
    readonly list?: readonly string[]
  }
  readonly skills?: string
  readonly untagged?: boolean
  readonly after?: string
}

export interface PluginProblem {
  readonly file: string
  readonly reason: string
}

export class PluginRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginRefused'
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const COMMAND = /^[A-Za-z0-9._-]{1,40}$/
/** The words of a command: nothing a shell reads as more than a word. */
const WORD = /^[A-Za-z0-9._:/=@,{}+-]{1,200}$/

function refuse(message: string): never {
  throw new PluginRefused(message)
}

function string(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    refuse(`"${field}" 要是 1 到 ${max} 个字的文字。`)
  }
  return value.trim()
}

function strings(value: unknown, field: string, max: number, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || value.length > max) refuse(`"${field}" 要是最多 ${max} 项的列表。`)
  return value.map((item, index) => {
    const text = string(item, `${field}[${index}]`, 300)
    if (pattern !== undefined && !pattern.test(text)) {
      refuse(`"${field}[${index}]" 只能有字母、数字和 . _ - : / = @ , + { }。`)
    }
    return text
  })
}

/** Checks a manifest and returns it in its exact shape; anything else is refused with the reason. */
export function checkManifest(value: unknown, reserved: ReadonlySet<string>): AgentPluginManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    refuse('插件要是一个 JSON 对象。')
  const record = value as Record<string, unknown>
  const known = new Set([
    'id',
    'name',
    'maker',
    'kind',
    'detect',
    'commands',
    'settings',
    'cli',
    'skills',
    'untagged',
    'after',
  ])
  const unknown = Object.keys(record).filter((key) => !known.has(key))
  if (unknown.length > 0) refuse(`不认识这些字段：${unknown.join('、')}。`)

  const id = string(record['id'], 'id', 40)
  if (!ID.test(id)) refuse('"id" 只能有小写字母、数字和 -，并以字母或数字开头。')
  if (reserved.has(id)) refuse(`"${id}" 已经是内置的 Agent，换一个 id。`)
  const kind = record['kind'] === undefined ? 'desktop' : record['kind']
  if (typeof kind !== 'string' || !(AGENT_KINDS as readonly string[]).includes(kind)) {
    refuse(`"kind" 要是 ${AGENT_KINDS.join('、')} 之一。`)
  }
  const commands =
    record['commands'] === undefined
      ? undefined
      : strings(record['commands'], 'commands', 5, COMMAND)

  let settings: AgentPluginManifest['settings']
  if (record['settings'] !== undefined) {
    const raw = record['settings'] as Record<string, unknown> | null
    if (typeof raw !== 'object' || raw === null) refuse('"settings" 要是一个对象。')
    const file = string(raw['file'], 'settings.file', 300)
    if (!/\.jsonc?$/i.test(file)) refuse('"settings.file" 要是 .json 或 .jsonc 文件。')
    const key = raw['key'] ?? 'mcpServers'
    const style = raw['style'] ?? 'url'
    if (!(SERVER_KEYS as readonly unknown[]).includes(key)) {
      refuse(`"settings.key" 要是 ${SERVER_KEYS.join('、')} 之一。`)
    }
    if (!(ENTRY_STYLES as readonly unknown[]).includes(style)) {
      refuse(`"settings.style" 要是 ${ENTRY_STYLES.join('、')} 之一。`)
    }
    settings = { file, key: key as ServerKey, style: style as EntryStyle }
  }

  let cli: AgentPluginManifest['cli']
  if (record['cli'] !== undefined) {
    const raw = record['cli'] as Record<string, unknown> | null
    if (typeof raw !== 'object' || raw === null) refuse('"cli" 要是一个对象。')
    if (commands === undefined || commands.length === 0)
      refuse('有 "cli" 时要在 "commands" 里写它的命令。')
    const add = strings(raw['add'], 'cli.add', 20, WORD)
    if (!add.includes('{url}')) refuse('"cli.add" 里要有一项是 {url}，换成工作台的地址。')
    const remove = strings(raw['remove'], 'cli.remove', 20, WORD)
    const list = raw['list'] === undefined ? undefined : strings(raw['list'], 'cli.list', 20, WORD)
    cli = { add, remove, ...(list === undefined ? {} : { list }) }
  }

  const skills =
    record['skills'] === undefined ? undefined : string(record['skills'], 'skills', 300)
  if (settings === undefined && cli === undefined && skills === undefined) {
    refuse('要写 "settings"、"cli" 或 "skills" 里的至少一个，否则不知道怎么接入。')
  }
  if (record['untagged'] !== undefined && typeof record['untagged'] !== 'boolean') {
    refuse('"untagged" 要是 true 或 false。')
  }
  const maker = record['maker'] === undefined ? undefined : string(record['maker'], 'maker', 40)
  const after = record['after'] === undefined ? undefined : string(record['after'], 'after', 200)
  const detect =
    record['detect'] === undefined ? undefined : strings(record['detect'], 'detect', 10)
  return {
    id,
    name: string(record['name'], 'name', 60),
    ...(maker === undefined ? {} : { maker }),
    kind: kind as Exclude<AgentKind, 'custom'>,
    ...(detect === undefined ? {} : { detect }),
    ...(commands === undefined ? {} : { commands }),
    ...(settings === undefined ? {} : { settings }),
    ...(cli === undefined ? {} : { cli }),
    ...(skills === undefined ? {} : { skills }),
    ...(record['untagged'] === true ? { untagged: true } : {}),
    ...(after === undefined ? {} : { after }),
  }
}

/** A plugin's path on this computer; one that is still not absolute is refused when it is used. */
export function expandPath(path: string, env: AgentEnvironment): string {
  const expanded = path
    .replace(/^~(?=$|[\\/])/, env.home)
    .replace(/^\{home\}/, env.home)
    .replace(/^\{appData\}/, env.appData)
    .replace(/^\{localAppData\}/, localAppData(env))
  if (!isAbsolute(expanded))
    refuse(`"${path}" 要以 ~、{home}、{appData}、{localAppData} 开头，或是完整路径。`)
  return join(expanded)
}

/** A checked manifest as an agent definition. */
export function pluginDefinition(
  manifest: AgentPluginManifest,
  env: AgentEnvironment,
): AgentDefinition {
  // Paths are checked now, so a plugin with a path that cannot be used is refused as a whole.
  const detect = (manifest.detect ?? []).map((path) => expandPath(path, env))
  const settingsFile =
    manifest.settings === undefined ? undefined : expandPath(manifest.settings.file, env)
  const skills = manifest.skills === undefined ? undefined : expandPath(manifest.skills, env)
  const command = manifest.commands?.[0]
  const cli = manifest.cli
  return {
    id: manifest.id,
    name: manifest.name,
    ...(manifest.maker === undefined ? {} : { maker: manifest.maker }),
    kind: manifest.kind ?? 'desktop',
    source: 'plugin',
    ...(manifest.commands === undefined ? {} : { commands: manifest.commands }),
    detect: () => [
      ...detect,
      ...(settingsFile === undefined ? [] : [settingsFile]),
      ...(skills === undefined ? [] : [skills]),
    ],
    ...(settingsFile === undefined
      ? {}
      : {
          settings: () => ({
            file: settingsFile,
            key: manifest.settings!.key ?? 'mcpServers',
            style: manifest.settings!.style ?? 'url',
          }),
        }),
    ...(cli === undefined
      ? {}
      : {
          cli: {
            add: (url: string) => cli.add.map((word) => (word === '{url}' ? url : word)),
            remove: cli.remove,
          },
          ...(cli.list === undefined || command === undefined || settingsFile !== undefined
            ? {}
            : {
                listed: async (environment: AgentEnvironment) => {
                  const { ok, output } = await environment.run(command, cli.list!)
                  return ok ? /^\s*episteme(\s|$)/m.test(output) : undefined
                },
              }),
        }),
    ...(skills === undefined ? {} : { skill: () => skills }),
    ...(manifest.untagged === true ? { untagged: true } : {}),
    ...(manifest.after === undefined ? {} : { after: manifest.after }),
  }
}

/** Reads every plugin in the folder. A file that cannot be used is reported, and the others still load. */
export async function loadPlugins(
  folder: string,
  env: AgentEnvironment,
  reserved: ReadonlySet<string>,
): Promise<{ definitions: AgentDefinition[]; problems: PluginProblem[] }> {
  let names: string[]
  try {
    names = (await readdir(folder)).filter((name) => /\.json$/i.test(name)).sort()
  } catch {
    return { definitions: [], problems: [] }
  }
  const definitions: AgentDefinition[] = []
  const problems: PluginProblem[] = []
  const seen = new Set(reserved)
  for (const name of names) {
    const file = join(folder, name)
    try {
      const errors: ParseError[] = []
      const parsed = parse(await readFile(file, 'utf8'), errors, {
        allowTrailingComma: true,
      }) as unknown
      if (errors.length > 0) refuse('不是能读懂的 JSON。')
      const manifest = checkManifest(parsed, seen)
      definitions.push(pluginDefinition(manifest, env))
      seen.add(manifest.id)
    } catch (error) {
      problems.push({ file, reason: error instanceof PluginRefused ? error.message : '读不出来。' })
    }
  }
  return { definitions, problems }
}
