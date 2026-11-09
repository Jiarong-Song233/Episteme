import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type AgentInfo, type AgentUse, type Me } from './api.js'

/**
 * The agents of this computer and their connection to the workbench: which are installed, which are connected, and
 * when each last called. Connecting adds one entry to the agent's own settings, through its own command when it has
 * one. An agent connected here may read and propose; only the person confirms, on the review page.
 */

const KINDS: Record<AgentInfo['kind'], string> = {
  cli: '命令行',
  editor: '编辑器',
  desktop: '桌面程序',
  extension: 'VS Code 扩展',
  manager: '替多个 Agent 管理设置',
  custom: '自定义',
}

const PLUGIN_EXAMPLE = `{
  "id": "my-agent",
  "name": "我的 Agent",
  "detect": ["~/.my-agent"],
  "settings": { "file": "~/.my-agent/mcp.json", "key": "mcpServers", "style": "type-http" }
}`

/** How each style of settings entry looks, for the custom-agent form. */
const STYLES: readonly { value: string; label: string }[] = [
  { value: 'url', label: '{ "url": 地址 }，多数客户端' },
  { value: 'type-http', label: '{ "type": "http", "url": 地址 }' },
  { value: 'httpUrl', label: '{ "httpUrl": 地址 }，Gemini 一类' },
  { value: 'serverUrl', label: '{ "serverUrl": 地址 }' },
  { value: 'streamableHttp', label: '{ "type": "streamableHttp", "url": 地址 }' },
  { value: 'stdio', label: '只能启动本地程序（通过中转）' },
]

const KEYS = ['mcpServers', 'servers', 'mcp', 'context_servers'] as const

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(at).toLocaleDateString()
}

function usedLine(use: AgentUse | undefined): string {
  if (use === undefined) return '还没有调用过'
  const tool = use.lastTool === undefined ? '' : `，最后用的是 ${use.lastTool}`
  return `${ago(use.lastSeen)}调用过，共 ${use.calls} 次${tool}`
}

function Copyable(props: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copyable">
      <pre aria-label={props.label}>{props.text}</pre>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          navigator.clipboard
            .writeText(props.text)
            .then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1600)
            })
            .catch(() => setCopied(false))
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  )
}

function status(agent: AgentInfo): { text: string; tone: 'on' | 'off' | 'warn' } {
  if (agent.connected === undefined) {
    return agent.how === 'manual'
      ? { text: '需要手动接入', tone: 'off' }
      : { text: '配置读不懂', tone: 'warn' }
  }
  if (!agent.connected) return { text: '未接入', tone: 'off' }
  if (agent.current === false) return { text: '地址已变，需重新接入', tone: 'warn' }
  return { text: '已接入', tone: 'on' }
}

function AgentRow(props: {
  agent: AgentInfo
  busy: boolean
  onConnect: () => void
  onDisconnect: () => void
  onRemove?: () => void
}) {
  const { agent } = props
  const [open, setOpen] = useState(false)
  const shown = status(agent)
  const canAct = agent.installed && agent.how !== 'manual'
  return (
    <li className="agent" data-tone={shown.tone}>
      <div className="agent-head">
        <div className="agent-name">
          <strong>{agent.name}</strong>
          <span className="hint">
            {[agent.maker, KINDS[agent.kind], agent.source === 'plugin' ? '插件' : undefined]
              .filter((part) => part !== undefined)
              .join('，')}
          </span>
        </div>
        <span className="agent-state" data-tone={shown.tone}>
          {shown.text}
        </span>
        <div className="agent-actions">
          {canAct &&
            (agent.connected === true && agent.current !== false ? (
              <button
                type="button"
                className="secondary"
                disabled={props.busy}
                onClick={props.onDisconnect}
              >
                {props.busy ? '正在断开…' : '断开'}
              </button>
            ) : (
              <button type="button" disabled={props.busy} onClick={props.onConnect}>
                {props.busy ? '正在接入…' : agent.connected === true ? '重新接入' : '接入'}
              </button>
            ))}
          <button
            type="button"
            className="link"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? '收起' : '详情'}
          </button>
        </div>
      </div>
      {agent.installed && <p className="hint agent-used">{usedLine(agent.use)}</p>}
      {open && (
        <div className="agent-detail">
          {agent.how === 'command' && <p className="hint">用它自己的 mcp 命令接入和断开。</p>}
          {agent.how === 'skill' && (
            <p className="hint">
              它不读 MCP 配置，但会读技能。接入时放进一个 episteme
              技能，教它用命令行调用工作台；断开时只删这个技能。
            </p>
          )}
          {agent.file !== undefined && (
            <p className="hint">
              {agent.how === 'skill' ? '技能文件：' : '配置文件：'}
              <code>{agent.file}</code>
              {agent.how === 'settings' &&
                '。只改其中 episteme 这一项，第一次改之前的原文件留在旁边的 .before-episteme。'}
            </p>
          )}
          <Copyable label={`${agent.name} 的接入地址`} text={agent.address} />
          {agent.how === 'manual' && (
            <p className="hint">
              把这个地址作为一个名为 episteme 的 HTTP MCP 服务器加到它的设置里。
            </p>
          )}
          {agent.after !== undefined && <p className="hint">{agent.after}</p>}
          {props.onRemove !== undefined && (
            <button
              type="button"
              className="link link-danger"
              disabled={props.busy}
              onClick={props.onRemove}
            >
              从列表里去掉
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function PluginForm(props: {
  folder: string | undefined
  problems: readonly { file: string; reason: string }[]
  onAdded: (name: string) => void
}) {
  const [manifest, setManifest] = useState('')
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<string>()

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setWorking(true)
    setProblem(undefined)
    api
      .importAgentPlugin(manifest)
      .then((reply) => {
        setManifest('')
        props.onAdded(reply.agent.name)
      })
      .catch((error: unknown) =>
        setProblem(error instanceof ApiError ? error.message : '没有加上，请重试。'),
      )
      .finally(() => setWorking(false))
  }

  return (
    <form className="panel model-form" onSubmit={submit}>
      <h3>用插件加入 Agent</h3>
      <p className="hint">
        插件是一个 JSON 文件，写明怎么找到这个 Agent、它的 MCP
        配置在哪，或它的命令、技能文件夹。插件只描述，接入时和内置的 Agent 一样只改 episteme
        这一项。
        {props.folder !== undefined && (
          <>
            {' '}
            也可以直接把文件放进 <code>{props.folder}</code>。
          </>
        )}
      </p>
      <label>
        插件内容
        <textarea
          value={manifest}
          onChange={(event) => setManifest(event.target.value)}
          placeholder={PLUGIN_EXAMPLE}
          rows={7}
          required
          spellCheck={false}
        />
      </label>
      <div className="actions">
        <button type="submit" disabled={working || manifest.trim() === ''}>
          {working ? '正在加入…' : '加入插件'}
        </button>
      </div>
      {problem !== undefined && (
        <p className="banner banner-error" role="status">
          {problem}
        </p>
      )}
      {props.problems.length > 0 && (
        <div className="banner banner-error" role="status">
          <p>这些插件文件没有用上：</p>
          <ul>
            {props.problems.map((item) => (
              <li key={item.file}>
                <code>{item.file}</code>：{item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  )
}

function CustomForm(props: { onAdded: () => void }) {
  const [name, setName] = useState('')
  const [file, setFile] = useState('')
  const [key, setKey] = useState<string>('mcpServers')
  const [style, setStyle] = useState('url')
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<string>()

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setWorking(true)
    setProblem(undefined)
    api
      .addCustomAgent({
        name: name.trim(),
        ...(file.trim() === '' ? {} : { file: file.trim(), key, style }),
      })
      .then(() => {
        setName('')
        setFile('')
        props.onAdded()
      })
      .catch((error: unknown) =>
        setProblem(error instanceof ApiError ? error.message : '没有添加，请重试。'),
      )
      .finally(() => setWorking(false))
  }

  return (
    <form className="panel model-form" onSubmit={submit}>
      <h3>添加自定义 Agent</h3>
      <p className="hint">
        自己写的
        Agent，或者列表里没有的客户端。填了配置文件，就能在这里一键接入；不填，就复制地址自己加。
      </p>
      <label>
        名字
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={60}
        />
      </label>
      <label>
        MCP 配置文件（可选，完整路径，.json 或 .jsonc）
        <input
          value={file}
          onChange={(event) => setFile(event.target.value)}
          placeholder="C:\Users\我\.my-agent\mcp.json"
          autoComplete="off"
        />
      </label>
      {file.trim() !== '' && (
        <>
          <label>
            服务器列表的名字
            <select value={key} onChange={(event) => setKey(event.target.value)}>
              {KEYS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label>
            写法
            <select value={style} onChange={(event) => setStyle(event.target.value)}>
              {STYLES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <div className="actions">
        <button type="submit" disabled={working}>
          {working ? '正在添加…' : '添加'}
        </button>
      </div>
      {problem !== undefined && (
        <p className="banner banner-error" role="status">
          {problem}
        </p>
      )}
    </form>
  )
}

export function ConnectPage({ me }: { me: Me }) {
  const [agents, setAgents] = useState<readonly AgentInfo[]>()
  const [others, setOthers] = useState<readonly AgentUse[]>([])
  const [busy, setBusy] = useState<string>()
  const [message, setMessage] = useState<{ ok: boolean; text: string }>()
  const [showMissing, setShowMissing] = useState(false)
  const [plugins, setPlugins] = useState<{
    folder: string
    problems: readonly { file: string; reason: string }[]
  }>()

  const load = useCallback(() => {
    api
      .agents()
      .then((reply) => {
        setAgents(reply.agents)
        setOthers(reply.others)
        setPlugins(reply.plugins)
      })
      .catch((error: unknown) =>
        setMessage({
          ok: false,
          text: error instanceof ApiError ? error.message : '读不到 Agent 列表。',
        }),
      )
  }, [])

  useEffect(() => {
    if (me.mode === 'shared') return
    load()
    // Keeps "last called" current while the page is open.
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [load, me.mode])

  if (me.mode === 'shared') {
    return (
      <div className="page connect">
        <h2 className="space-title">接入 Agent</h2>
        <p className="page-hint">
          这个服务是多人模式，Agent 需要一个令牌才能连接。请联系管理这个服务的人。
        </p>
      </div>
    )
  }

  const act = (
    agent: AgentInfo,
    work: () => Promise<{ agent: AgentInfo; said?: string }>,
    done: string,
  ) => {
    setBusy(agent.id)
    setMessage(undefined)
    work()
      .then((reply) => {
        const after = done === 'connected' ? (reply.agent.after ?? '') : ''
        setMessage({
          ok: true,
          text:
            done === 'connected'
              ? `${agent.name} 已接入。${after}${reply.said === undefined ? '' : `（它自己的命令没成功，已改它的配置文件：${reply.said}）`}`
              : `${agent.name} 已断开，它的其他设置没有改动。`,
        })
        load()
      })
      .catch((error: unknown) =>
        setMessage({
          ok: false,
          text: error instanceof ApiError ? error.message : '没有完成，请重试。',
        }),
      )
      .finally(() => setBusy(undefined))
  }

  const row = (agent: AgentInfo) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      busy={busy === agent.id}
      onConnect={() => act(agent, () => api.connectAgent(agent.id), 'connected')}
      onDisconnect={() => act(agent, () => api.disconnectAgent(agent.id), 'disconnected')}
      {...(agent.kind === 'custom' || agent.source === 'plugin'
        ? {
            onRemove: () => {
              setBusy(agent.id)
              ;(agent.source === 'plugin'
                ? api.removeAgentPlugin(agent.id)
                : api.removeCustomAgent(agent.id)
              )
                .then(load)
                .catch(() => setMessage({ ok: false, text: '没有去掉，请重试。' }))
                .finally(() => setBusy(undefined))
            },
          }
        : {})}
    />
  )

  const address = `${window.location.origin}/mcp`
  const installed = agents?.filter((agent) => agent.installed) ?? []
  const missing = agents?.filter((agent) => !agent.installed) ?? []
  const connected = installed.filter((agent) => agent.connected === true).length

  return (
    <div className="page connect">
      <h2 className="space-title">接入 Agent</h2>
      <p className="hint page-hint">
        接入后，Agent
        能取回你确认过的理解，也能提出新的候选理解。候选会出现在“待确认”里，只有你确认的才算数。
      </p>

      {message !== undefined && (
        <p className={message.ok ? 'banner' : 'banner banner-error'} role="status">
          {message.text}
        </p>
      )}

      <section className="panel">
        <h3>
          这台电脑上的 Agent
          {agents !== undefined && (
            <span className="count">{`${connected} / ${installed.length} 已接入`}</span>
          )}
        </h3>
        {agents === undefined ? (
          <p className="hint">正在查找…</p>
        ) : installed.length === 0 ? (
          <p className="hint">
            没有找到已安装的 Agent。装好以后回到这里，或在下面添加自定义 Agent。
          </p>
        ) : (
          <ul className="agents">{installed.map(row)}</ul>
        )}
      </section>

      {others.length > 0 && (
        <section className="panel">
          <h3>其他连过的客户端</h3>
          <p className="hint">
            它们没有用这里给的地址，是自己连上来的。本机模式下，这台电脑上的程序都能连接。
          </p>
          <ul className="agents">
            {others.map((use) => (
              <li className="agent" key={use.key}>
                <div className="agent-head">
                  <div className="agent-name">
                    <strong>{use.name}</strong>
                    {use.version !== undefined && <span className="hint">{use.version}</span>}
                  </div>
                  <span className="hint">{usedLine(use)}</span>
                  <div className="agent-actions">
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        api
                          .forgetAgentUse(use.key)
                          .then(load)
                          .catch(() => undefined)
                      }}
                    >
                      不再显示
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <CustomForm onAdded={load} />

      <PluginForm
        folder={plugins?.folder}
        problems={plugins?.problems ?? []}
        onAdded={(name) => {
          setMessage({ ok: true, text: `已加入插件：${name}。` })
          load()
        }}
      />

      {missing.length > 0 && (
        <section className="panel">
          <h3>
            <button
              type="button"
              className="link"
              aria-expanded={showMissing}
              onClick={() => setShowMissing((was) => !was)}
            >
              {showMissing ? '收起' : `还支持 ${missing.length} 个没有在这台电脑上找到的 Agent`}
            </button>
          </h3>
          {showMissing && <ul className="agents">{missing.map(row)}</ul>}
        </section>
      )}

      <section className="panel">
        <h3>手动接入</h3>
        <p className="hint">
          上面没有的 Agent，或者你想自己改配置时，用这个地址。它支持 MCP 的 Streamable HTTP。
        </p>
        <Copyable label="MCP 地址" text={address} />
        <p className="hint">Claude Code 可以在终端里运行：</p>
        <Copyable
          label="Claude Code 的接入方式"
          text={`claude mcp add --transport http --scope user episteme ${address}`}
        />
      </section>

      <section className="panel">
        <h3>接好以后</h3>
        <p>对 Agent 说：“用 episteme 帮我学这份材料，把要点提给我确认。”</p>
        <p className="hint">Episteme 关掉时，Agent 连不上它；再打开就好。</p>
      </section>
    </div>
  )
}
