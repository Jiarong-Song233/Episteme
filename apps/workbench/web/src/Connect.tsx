import { useState } from 'react'
import type { Me } from './api.js'

/**
 * How an agent reaches this service, ready to copy. An agent may read and propose; only the person confirms, on the
 * review page, so nothing here grants it more than that.
 */

interface Client {
  readonly name: string
  readonly where: string
  readonly text: (address: string) => string
}

const CLIENTS: readonly Client[] = [
  {
    name: 'Claude Code',
    where: '在终端里运行一次：',
    text: (address) => `claude mcp add --transport http --scope user episteme ${address}`,
  },
  {
    name: 'Codex',
    where: '在终端里运行一次：',
    text: (address) => `codex mcp add episteme --url ${address}`,
  },
  {
    name: '其他支持 MCP 的客户端',
    where: '加进它的 MCP 配置：',
    text: (address) =>
      JSON.stringify({ mcpServers: { episteme: { type: 'http', url: address } } }, null, 2),
  },
]

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

export function ConnectPage({ me }: { me: Me }) {
  const address = `${window.location.origin}/mcp`
  return (
    <div className="page connect">
      <h2 className="space-title">接入 Agent</h2>
      <p className="hint page-hint">
        Agent 通过 MCP
        连到这里：它能取回你确认过的理解，也能提出新的候选理解。候选会出现在“待确认”里，只有你确认的才算数。
      </p>
      {me.mode === 'shared' ? (
        <p className="page-hint">
          这个服务是多人模式，Agent 需要一个令牌才能连接。请联系管理这个服务的人。
        </p>
      ) : (
        <>
          <section className="panel">
            <h3>MCP 地址</h3>
            <Copyable label="MCP 地址" text={address} />
            <p className="hint">这个地址只在这台电脑上能用。Episteme 关掉时，Agent 也连不上。</p>
          </section>
          {CLIENTS.map((client) => (
            <section className="panel" key={client.name}>
              <h3>{client.name}</h3>
              <p className="hint">{client.where}</p>
              <Copyable label={`${client.name} 的接入方式`} text={client.text(address)} />
            </section>
          ))}
          <section className="panel">
            <h3>接好以后</h3>
            <p>对 Agent 说：“用 episteme 帮我学这份材料，把要点提给我确认。”</p>
            <p className="hint">它提出的内容会出现在左边的“待确认”里。</p>
          </section>
        </>
      )}
    </div>
  )
}
