import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPerson, addToken, startService, type EpistemeService } from '@episteme/service'
import {
  Agents,
  addressFor,
  SimulatedModel,
  workbenchProfile,
  type AgentEnvironment,
} from '@episteme/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpWire } from './mcp-wire.js'

/**
 * Connecting the agents of this computer: it finds them, adds the workbench with their own command or by changing
 * only its entry in their settings, keeps what was there, tells which ones have called, and lets only the person see
 * or change any of it. Every path here is in a temporary folder: the real settings of the computer running the tests
 * are never read or touched.
 */

const MCP = 'http://127.0.0.1:4322/mcp'

let directory: string
let home: string
let bin: string
let ran: { command: string; args: readonly string[] }[]
let commandWorks: boolean
/** What a command prints when it works, by command. */
let printed: Record<string, string>

function environment(): AgentEnvironment {
  return {
    home,
    platform: process.platform,
    appData: join(home, 'AppData'),
    env: { PATH: bin, PATHEXT: '.CMD;.EXE', LOCALAPPDATA: join(home, 'AppData', 'Local') },
    run: (command, args) => {
      ran.push({ command, args })
      return Promise.resolve({
        ok: commandWorks,
        output: commandWorks ? (printed[command] ?? 'ok') : 'Error: refused\n',
      })
    },
    bridge: { command: '/path/to/node', args: ['/path/to/mcp-bridge.js'] },
  }
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** A command on the temporary PATH, as an installed agent would put it there. */
async function install(command: string): Promise<void> {
  await put(join(bin, process.platform === 'win32' ? `${command}.cmd` : command), '')
}

async function open(): Promise<Agents> {
  return Agents.open(join(directory, 'agents.json'), environment(), () => MCP)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-agents-'))
  home = join(directory, 'home')
  bin = join(directory, 'bin')
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  ran = []
  commandWorks = true
  printed = {}
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})

describe('the agents of this computer', () => {
  it('finds the installed ones, by their command or their folder, and lists the rest after them', async () => {
    await install('claude')
    await mkdir(join(home, '.cursor'))
    const { agents } = await (await open()).list()
    const installed = agents.filter((agent) => agent.installed).map((agent) => agent.id)
    expect(installed.sort()).toEqual(['claude-code', 'cursor'])
    expect(agents.slice(0, 2).every((agent) => agent.installed)).toBe(true)
    expect(agents.map((agent) => agent.id)).toEqual(
      expect.arrayContaining([
        'codex',
        'gemini-cli',
        'qwen-code',
        'kimi-cli',
        'trae',
        'trae-cn',
        'vscode',
      ]),
    )
    const cursor = agents.find((agent) => agent.id === 'cursor')!
    expect(cursor).toMatchObject({
      how: 'settings',
      connected: false,
      address: addressFor(MCP, 'cursor'),
    })
    expect(cursor.address).toBe('http://127.0.0.1:4322/mcp?client=cursor')
  })

  it('connects through the settings file, keeping every other server, comment and setting', async () => {
    const file = join(home, '.config', 'opencode', 'opencode.jsonc')
    const before = [
      '{',
      '  // my own note',
      '  "theme": "dark",',
      '  "mcp": {',
      '    "other": { "type": "local", "command": ["x"] },',
      '  },',
      '}',
      '',
    ].join('\n')
    await put(file, before)
    const agents = await open()

    const { agent } = await agents.connect('opencode')
    expect(agent).toMatchObject({ connected: true, current: true, file })
    const after = await readFile(file, 'utf8')
    expect(after).toContain('// my own note')
    expect(after).toContain('"theme": "dark"')
    expect(after).toContain('"other"')
    expect(after).toContain('"type": "remote"')
    expect(after).toContain('"url": "http://127.0.0.1:4322/mcp?client=opencode"')
    expect(await readFile(`${file}.before-episteme`, 'utf8')).toBe(before)

    await agents.disconnect('opencode')
    const removed = await readFile(file, 'utf8')
    expect(removed).not.toContain('episteme')
    expect(removed).toContain('"other"')
    expect(removed).toContain('// my own note')
    expect((await agents.list()).agents.find((a) => a.id === 'opencode')).toMatchObject({
      connected: false,
    })
  })

  it('writes each agent in its own way, and a stdio-only client through the relay', async () => {
    await mkdir(join(home, 'AppData', 'Claude'), { recursive: true })
    await mkdir(join(home, '.gemini'))
    await mkdir(join(home, 'AppData', 'Code'), { recursive: true })
    const agents = await open()
    for (const id of ['claude-desktop', 'gemini-cli', 'vscode']) await agents.connect(id)

    const desktop = JSON.parse(
      await readFile(join(home, 'AppData', 'Claude', 'claude_desktop_config.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> }
    expect(desktop.mcpServers['episteme']).toEqual({
      command: '/path/to/node',
      args: ['/path/to/mcp-bridge.js', 'http://127.0.0.1:4322/mcp?client=claude-desktop'],
    })
    const gemini = JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(gemini.mcpServers['episteme']).toEqual({
      httpUrl: 'http://127.0.0.1:4322/mcp?client=gemini-cli',
    })
    const vscode = JSON.parse(
      await readFile(join(home, 'AppData', 'Code', 'User', 'mcp.json'), 'utf8'),
    ) as {
      servers: Record<string, unknown>
    }
    expect(vscode.servers['episteme']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4322/mcp?client=vscode',
    })
    // No settings file had to be kept: there was none before.
    expect(existsSync(join(home, '.gemini', 'settings.json.before-episteme'))).toBe(false)
  })

  it('uses the agent’s own command when it has one, replacing an old address', async () => {
    await install('claude')
    const agents = await open()
    await agents.connect('claude-code')
    expect(ran).toEqual([
      { command: 'claude', args: ['mcp', 'remove', '--scope', 'user', 'episteme'] },
      {
        command: 'claude',
        args: [
          'mcp',
          'add',
          '--transport',
          'http',
          '--scope',
          'user',
          'episteme',
          'http://127.0.0.1:4322/mcp?client=claude-code',
        ],
      },
    ])
    // Its own command did the writing; the settings file was not touched.
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
  })

  it('falls back to the settings file when the command refuses, and says what it said', async () => {
    await install('gemini')
    commandWorks = false
    const agents = await open()
    const connected = await agents.connect('gemini-cli')
    expect(connected.said).toContain('refused')
    expect(connected.agent.connected).toBe(true)
  })

  it('reads whether Codex lists the workbench, and connects it only through its own command', async () => {
    await put(join(home, '.codex', 'config.toml'), '[mcp_servers.episteme]\nurl = "x"\n')
    let codex = (await (await open()).list()).agents.find((agent) => agent.id === 'codex')!
    expect(codex).toMatchObject({ installed: true, connected: true, how: 'manual' })
    await expect((await open()).connect('codex')).rejects.toMatchObject({ code: 'cannot_connect' })

    await install('codex')
    const agents = await open()
    codex = (await agents.connect('codex')).agent
    expect(ran.at(-1)).toEqual({
      command: 'codex',
      args: ['mcp', 'add', 'episteme', '--url', 'http://127.0.0.1:4322/mcp?client=codex'],
    })
  })

  it('refuses a settings file it cannot read, and leaves it as it was', async () => {
    const file = join(home, '.cursor', 'mcp.json')
    await put(file, '{ "mcpServers": { oops')
    const agents = await open()
    await expect(agents.connect('cursor')).rejects.toMatchObject({ code: 'unreadable_settings' })
    expect(await readFile(file, 'utf8')).toBe('{ "mcpServers": { oops')
    expect((await agents.list()).agents.find((a) => a.id === 'cursor')!.connected).toBeUndefined()
  })

  it('refuses an agent that is not installed, and one it does not know', async () => {
    const agents = await open()
    await expect(agents.connect('windsurf')).rejects.toMatchObject({ code: 'not_installed' })
    await expect(agents.connect('nothing')).rejects.toMatchObject({ code: 'unknown_agent' })
  })

  it('adds a custom agent, connects it, and keeps it across starts', async () => {
    const file = join(directory, 'mine', 'servers.json')
    const agents = await open()
    await expect(agents.addCustom({ name: 'x', file: 'relative.json' })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await expect(
      agents.addCustom({ name: 'x', file: join(directory, 'a.toml') }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    })
    const { agent } = await agents.addCustom({
      name: '我的 Agent',
      file,
      key: 'servers',
      style: 'httpUrl',
    })
    expect(agent).toMatchObject({
      kind: 'custom',
      installed: true,
      connected: false,
      how: 'settings',
    })
    await agents.connect(agent.id)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      servers: { episteme: { httpUrl: `http://127.0.0.1:4322/mcp?client=${agent.id}` } },
    })

    const later = await open()
    expect((await later.list()).agents.find((a) => a.id === agent.id)).toMatchObject({
      name: '我的 Agent',
      connected: true,
    })
    const manual = await later.addCustom({ name: '手动接入的' })
    expect(manual.agent.how).toBe('manual')
    await later.removeCustom(agent.id)
    expect((await later.list()).agents.some((a) => a.id === agent.id)).toBe(false)
    // Forgetting it does not change its settings: that is what disconnecting is for.
    expect(await readFile(file, 'utf8')).toContain('episteme')
  })

  it('tells which agent called, from its address or the name it gives', async () => {
    const agents = await open()
    agents.note({ at: 1000, method: 'initialize', client: 'cursor' })
    agents.note({ at: 2000, method: 'tools/call', client: 'cursor', tool: 'recall' })
    agents.note({
      at: 3000,
      method: 'tools/call',
      clientInfo: { name: 'claude-code', version: '2.1' },
    })
    agents.note({ at: 4000, method: 'tools/call', clientInfo: { name: 'hand-made-agent' } })
    await agents.flush()
    const { agents: listed, others } = await (await open()).list()
    expect(listed.find((a) => a.id === 'cursor')!.use).toMatchObject({
      firstSeen: 1000,
      lastSeen: 2000,
      calls: 1,
      lastTool: 'recall',
    })
    expect(listed.find((a) => a.id === 'claude-code')!.use).toMatchObject({
      version: '2.1',
      lastSeen: 3000,
    })
    expect(others).toEqual([expect.objectContaining({ name: 'hand-made-agent', lastSeen: 4000 })])
  })

  it('never gives one client another’s name, when both send the same user agent', async () => {
    const agents = await open()
    const userAgent = 'node'
    agents.note({
      at: 1,
      method: 'initialize',
      client: 'cursor',
      userAgent,
      clientInfo: { name: 'Cursor', version: '3' },
    })
    agents.note({ at: 2, method: 'initialize', userAgent, clientInfo: { name: 'mine' } })
    agents.note({ at: 3, method: 'tools/call', client: 'cursor', userAgent, tool: 'recall' })
    agents.note({ at: 4, method: 'tools/call', userAgent, tool: 'propose' })
    const { agents: listed, others } = await agents.list()
    expect(listed.find((a) => a.id === 'cursor')!.use).toMatchObject({
      name: 'Cursor',
      version: '3',
      calls: 1,
    })
    expect(others).toEqual([
      expect.objectContaining({ name: 'mine', calls: 1, lastTool: 'propose' }),
    ])
  })
})

describe('agents of other kinds', () => {
  it('writes WorkBuddy, Qoder CN and Antigravity in their own ways', async () => {
    await mkdir(join(home, '.workbuddy'))
    await put(join(home, '.qoder-cn', 'settings.json'), '{ "enabledPlugins": { "x": true } }\n')
    await mkdir(join(home, '.gemini', 'antigravity'), { recursive: true })
    const agents = await open()
    for (const id of ['workbuddy', 'qoder-cn', 'antigravity']) await agents.connect(id)
    const read = async (...path: string[]) =>
      JSON.parse(await readFile(join(home, ...path), 'utf8')) as {
        mcpServers: Record<string, unknown>
        enabledPlugins?: unknown
      }
    expect((await read('.workbuddy', 'mcp.json')).mcpServers['episteme']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4322/mcp?client=workbuddy',
    })
    const qoder = await read('.qoder-cn', 'settings.json')
    expect(qoder.mcpServers['episteme']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4322/mcp?client=qoder-cn',
    })
    expect(qoder.enabledPlugins).toEqual({ x: true })
    expect(
      (await read('.gemini', 'antigravity', 'mcp_config.json')).mcpServers['episteme'],
    ).toEqual({ serverUrl: 'http://127.0.0.1:4322/mcp?client=antigravity' })
  })

  it('uses the Store version’s settings of Claude Desktop when that is the one there', async () => {
    if (process.platform !== 'win32') return
    const file = join(home, 'AppData', 'Local', 'Claude', 'claude_desktop_config.json')
    await put(file, '{}\n')
    const agents = await open()
    const { agent } = await agents.connect('claude-desktop')
    expect(agent).toMatchObject({ installed: true, connected: true, file })
    expect(existsSync(join(home, 'AppData', 'Claude', 'claude_desktop_config.json'))).toBe(false)
  })

  it('connects the Antigravity CLI with agy, and reads from agy whether it lists the workbench', async () => {
    await install('agy')
    const agents = await open()
    printed['agy'] = 'No MCP servers configured.\n'
    let agy = (await agents.list()).agents.find((agent) => agent.id === 'antigravity-cli')!
    expect(agy).toMatchObject({ installed: true, connected: false, how: 'command' })

    printed['agy'] = 'NAME      TYPE  STATUS   COMMAND/URL\nepisteme  http  enabled  http://x\n'
    agy = (await agents.connect('antigravity-cli')).agent
    expect(ran.slice(-3, -1)).toEqual([
      { command: 'agy', args: ['mcp', 'remove', 'episteme'] },
      {
        command: 'agy',
        args: [
          'mcp',
          'add',
          '--type',
          'http',
          'episteme',
          'http://127.0.0.1:4322/mcp?client=antigravity-cli',
        ],
      },
    ])
    expect(agy.connected).toBe(true)
    // What agy said is kept a little while, so the list does not run it again at once.
    const before = ran.length
    await agents.list()
    expect(ran.length).toBe(before)
  })

  it('gives magpie the plain address, for the agents only it can write, and reads its library', async () => {
    await install('magpie')
    printed['magpie'] = [
      'Instructions',
      '  none',
      'MCP servers',
      '  episteme → pi, hermes',
      '  in your agents, not in the library: other (agy)',
      'Skills',
      '  episteme-notes → kimi',
      '',
    ].join('\n')
    const agents = await open()
    const { agent } = await agents.connect('magpie')
    expect(ran.at(-2)).toEqual({
      command: 'magpie',
      args: [
        'library',
        'mcp',
        'add',
        'episteme',
        'http://127.0.0.1:4322/mcp',
        'agents=pi,hermes,openclaw,zcode,dsh',
      ],
    })
    expect(agent).toMatchObject({ kind: 'manager', connected: true, address: MCP })

    printed['magpie'] = 'MCP servers\n  none yet\nSkills\n  episteme → kimi\n'
    const later = await open()
    expect((await later.list()).agents.find((a) => a.id === 'magpie')!.connected).toBe(false)
  })

  it('gives 豆包工作 a skill, and takes away only the one it wrote', async () => {
    const skills = join(
      home,
      'AppData',
      'Local',
      'DoubaoWork',
      'User Data',
      'Default',
      '.doubaowork',
      'agent_mode',
      'workspace',
      '.skills',
    )
    if (process.platform !== 'win32') return
    await mkdir(join(skills, 'doubao-search'), { recursive: true })
    const agents = await open()
    const { agent } = await agents.connect('doubao-work')
    const file = join(skills, 'episteme', 'SKILL.md')
    expect(agent).toMatchObject({ how: 'skill', connected: true, current: true, file })
    const skill = await readFile(file, 'utf8')
    expect(skill).toMatch(/^---\nname: episteme\n/)
    expect(skill).toContain('"/path/to/node" "')
    expect(skill).toContain('episteme-cli.js" --url "http://127.0.0.1:4322/mcp?client=doubao-work"')
    expect(skill).toContain('不能替这个人确认理解')

    await agents.disconnect('doubao-work')
    expect(existsSync(join(skills, 'episteme'))).toBe(false)
    expect(existsSync(join(skills, 'doubao-search'))).toBe(true)

    // A skill of the same name the person wrote is not theirs to lose.
    await put(file, '---\nname: episteme\n---\nmine\n')
    expect((await agents.list()).agents.find((a) => a.id === 'doubao-work')!.connected).toBe(false)
    await agents.disconnect('doubao-work')
    expect(await readFile(file, 'utf8')).toContain('mine')
  })
})

describe('agent plugins', () => {
  const plugins = () => join(directory, 'agent-plugins')

  it('lists an agent a plugin describes, connects it, and reports a plugin it cannot use', async () => {
    await put(
      join(plugins(), 'lab.json'),
      JSON.stringify({
        id: 'lab-agent',
        name: '实验室 Agent',
        maker: '某实验室',
        detect: ['~/.lab'],
        settings: { file: '{home}/.lab/mcp.json', key: 'servers', style: 'streamable-http' },
        after: '重启后生效。',
      }),
    )
    await put(join(plugins(), 'broken.json'), '{ "id": "x" ')
    await put(
      join(plugins(), 'clash.json'),
      JSON.stringify({ id: 'cursor', name: 'x', skills: '~/s' }),
    )
    await mkdir(join(home, '.lab'))
    const agents = await open()
    const listed = await agents.list()
    const lab = listed.agents.find((agent) => agent.id === 'lab-agent')!
    expect(lab).toMatchObject({
      name: '实验室 Agent',
      source: 'plugin',
      installed: true,
      connected: false,
      how: 'settings',
    })
    expect(listed.plugins.problems.map((problem) => problem.file).sort()).toEqual([
      join(plugins(), 'broken.json'),
      join(plugins(), 'clash.json'),
    ])
    expect(listed.plugins.problems.find((p) => p.file.endsWith('clash.json'))!.reason).toContain(
      '内置',
    )

    await agents.connect('lab-agent')
    expect(JSON.parse(await readFile(join(home, '.lab', 'mcp.json'), 'utf8'))).toEqual({
      servers: {
        episteme: {
          type: 'streamable-http',
          url: 'http://127.0.0.1:4322/mcp?client=lab-agent',
        },
      },
    })
  })

  it('runs a plugin’s command only with plain words and the workbench’s address', async () => {
    const agents = await open()
    await expect(
      agents.importPlugin(
        JSON.stringify({
          id: 'sneaky',
          name: 'x',
          commands: ['x'],
          cli: { add: ['add', '{url}', '&', 'calc'], remove: ['rm'] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      agents.importPlugin(JSON.stringify({ id: 'a', name: 'x', commands: ['x;y'], cli: {} })),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      agents.importPlugin(JSON.stringify({ id: 'a', name: 'x', settings: { file: 'rel.json' } })),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      agents.importPlugin(JSON.stringify({ id: 'a', name: 'x', extra: 1, skills: '~/s' })),
    ).rejects.toMatchObject({ code: 'invalid_request' })

    await install('tool')
    const { agent } = await agents.importPlugin(
      JSON.stringify({
        id: 'tool-agent',
        name: 'Tool',
        kind: 'cli',
        commands: ['tool'],
        cli: {
          add: ['mcp', 'add', 'episteme', '{url}'],
          remove: ['mcp', 'remove', 'episteme'],
          list: ['mcp', 'list'],
        },
      }),
    )
    expect(agent).toMatchObject({ how: 'command', installed: true, source: 'plugin' })
    expect(existsSync(join(plugins(), 'tool-agent.json'))).toBe(true)
    printed['tool'] = 'episteme http://127.0.0.1:4322/mcp?client=tool-agent\n'
    const connected = await agents.connect('tool-agent')
    expect(ran.at(-2)).toEqual({
      command: 'tool',
      args: ['mcp', 'add', 'episteme', 'http://127.0.0.1:4322/mcp?client=tool-agent'],
    })
    expect(connected.agent.connected).toBe(true)

    await agents.removePlugin('tool-agent')
    expect(existsSync(join(plugins(), 'tool-agent.json'))).toBe(false)
    expect((await agents.list()).agents.some((a) => a.id === 'tool-agent')).toBe(false)
    await expect(agents.removePlugin('cursor')).rejects.toMatchObject({ code: 'unknown_agent' })
  })
})

describe('the agents page over the service', () => {
  let service: EpistemeService | undefined
  afterEach(async () => {
    await service?.close()
    service = undefined
  })

  async function call(path: string, body?: unknown, token?: string) {
    const response = await fetch(`${service!.url}/api/v1/scene/workbench${path}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it('is the person’s alone, and notes the agents that call over MCP', async () => {
    await mkdir(join(home, '.cursor'))
    let url = MCP
    const agents = await Agents.open(join(directory, 'agents.json'), environment(), () => url)
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel(), agents }),
      onMcpActivity: (activity) => agents.note(activity),
    })
    url = service.mcpUrl
    const person = service.humanToken!

    expect((await call('/agents')).status).toBe(401)
    expect((await call('/agents/connect', { id: 'cursor' })).status).toBe(401)
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false)

    const connected = await call('/agents/connect', { id: 'cursor' }, person)
    expect(connected.status).toBe(200)
    const address = (connected.body['agent'] as { address: string }).address
    expect(address).toBe(`${service.mcpUrl}?client=cursor`)

    const host = mcpWire(() => address, { name: 'Cursor', version: '3.0' })
    expect((await host.rpc('tools/list')).status).toBe(200)
    await host.call('recall', { query: 'x' })
    const listed = await call('/agents', undefined, person)
    const cursor = (listed.body['agents'] as { id: string; use?: Record<string, unknown> }[]).find(
      (agent) => agent.id === 'cursor',
    )!
    expect(cursor.use).toMatchObject({
      name: 'Cursor',
      version: '3.0',
      calls: 1,
      lastTool: 'recall',
    })

    const refused = await call('/agents/connect', { id: 'windsurf' }, person)
    expect(refused).toMatchObject({ status: 422, body: { code: 'not_installed' } })
  })

  it('relays a stdio-only client to the workbench, message for message', async () => {
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel() }),
    })
    const bridge = join(import.meta.dirname, '..', 'apps', 'workbench', 'dist', 'mcp-bridge.js')
    const child = spawn(process.execPath, [bridge, `${service.mcpUrl}?client=claude-desktop`], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const lines: string[] = []
    let buffered = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      lines.push(...parts.filter((line) => line !== ''))
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-ai', version: '1' },
        },
      })}\n`,
    )
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    )
    const deadline = Date.now() + 10_000
    while (lines.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    child.stdin.end()
    await new Promise((resolve) => child.once('exit', resolve))
    const answers = lines.map(
      (line) => JSON.parse(line) as { id: number; result?: Record<string, unknown> },
    )
    expect(answers.map((answer) => answer.id).sort()).toEqual([1, 2])
    const tools = answers.find((answer) => answer.id === 2)!.result!['tools'] as { name: string }[]
    expect(tools.map((tool) => tool.name)).toContain('recall')
  })

  it('lets an agent with only a skill call the tools from the command line', async () => {
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel() }),
    })
    const cli = join(import.meta.dirname, '..', 'apps', 'workbench', 'dist', 'episteme-cli.js')
    const run = (args: string[], input?: string) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn(process.execPath, [
          cli,
          '--url',
          `${service!.mcpUrl}?client=doubao-work`,
          ...args,
        ])
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
        child.once('exit', (code) => resolve({ code, out, err }))
        child.stdin.end(input ?? '')
      })
    const tools = await run(['tools'])
    expect(tools.code).toBe(0)
    expect(tools.out).toMatch(/^recall\(question/m)
    expect(tools.out).toContain('propose(')

    const recalled = await run(['call', 'recall', '-'], JSON.stringify({ question: '贝叶斯定理' }))
    expect(recalled).toMatchObject({ code: 0 })
    expect(recalled.out.trim()).not.toBe('')

    const wrong = await run(['call', 'recall', 'not json'])
    expect(wrong.code).toBe(2)
    const elsewhere = spawn(process.execPath, [cli, '--url', 'http://example.com/mcp', 'tools'])
    expect(await new Promise((resolve) => elsewhere.once('exit', resolve))).toBe(2)
  })

  it('takes a plugin from the person only', async () => {
    const agents = await open()
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      profile: workbenchProfile({ model: new SimulatedModel(), agents }),
    })
    const manifest = JSON.stringify({ id: 'mine', name: '我的', skills: '~/.mine/skills' })
    expect((await call('/agents/plugins', { manifest })).status).toBe(401)
    const imported = await call('/agents/plugins', { manifest }, service.humanToken)
    expect(imported.status).toBe(200)
    expect(imported.body['agent']).toMatchObject({ id: 'mine', how: 'skill', source: 'plugin' })
    const refused = await call('/agents/plugins', { manifest: '{"id":"x"}' }, service.humanToken)
    expect(refused).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    const removed = await call('/agents/plugins/remove', { id: 'mine' }, service.humanToken)
    expect(removed.status).toBe(200)
  })

  it('refuses an agent’s own credential, so one agent cannot read or change another’s settings', async () => {
    await mkdir(join(home, '.cursor'))
    const users = join(directory, 'users.json')
    const lin = await addPerson(users, 'Lin')
    const human = await addToken(users, lin, 'human', 'workspace')
    const agent = await addToken(users, lin, 'agent', 'claude-code')
    const agents = await open()
    service = await startService({
      graph: join(directory, 'graph.db'),
      port: 0,
      mode: 'shared',
      users,
      publicOrigin: 'http://127.0.0.1',
      profile: workbenchProfile({ model: new SimulatedModel(), agents }),
    })
    expect((await call('/agents', undefined, agent)).status).toBe(403)
    expect((await call('/agents/connect', { id: 'cursor' }, agent)).status).toBe(403)
    expect((await call('/agents/custom', { name: 'x' }, agent)).status).toBe(403)
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false)
    expect((await call('/agents', undefined, human)).status).toBe(200)
  })
})
