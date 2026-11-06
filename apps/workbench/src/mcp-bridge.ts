#!/usr/bin/env node
import { createInterface } from 'node:readline'

/**
 * Lets a client that only starts local MCP servers, such as Claude Desktop, reach the workbench.
 *
 * It reads JSON-RPC messages, one per line, from its input, sends each to the workbench's MCP address, and writes the
 * answers back one per line. It adds nothing: what the agent may do is what the address allows.
 *
 *   node mcp-bridge.js http://127.0.0.1:4322/mcp?client=claude-desktop
 */

const address = process.argv[2]
if (address === undefined || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(address)) {
  process.stderr.write('用法：node mcp-bridge.js http://127.0.0.1:<端口>/mcp\n')
  process.exit(2)
}

let session: string | undefined

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** An error answer for a request the workbench did not answer, so the client is not left waiting. */
function failed(line: string, reason: string): void {
  let id: unknown
  try {
    id = (JSON.parse(line) as { id?: unknown }).id
  } catch {
    return
  }
  if (id === undefined || id === null) return
  write({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: `Episteme 工作台没有回应：${reason}` },
  })
}

async function send(line: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(address!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session === undefined ? {} : { 'mcp-session-id': session }),
      },
      body: line,
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    failed(line, `请确认工作台正在运行（${(error as Error).message}）`)
    return
  }
  session = response.headers.get('mcp-session-id') ?? session
  const body = await response.text()
  if (body.trim() === '') {
    if (!response.ok) failed(line, `HTTP ${response.status}`)
    return
  }
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((part) => part.startsWith('data:'))
        .map((part) => part.slice(5).trimStart())
        .join('\n')
      if (data !== '') write(JSON.parse(data))
    }
    return
  }
  try {
    const parsed = JSON.parse(body) as unknown
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) write(message)
  } catch {
    failed(line, `HTTP ${response.status}`)
  }
}

const lines = createInterface({ input: process.stdin })
const pending = new Set<Promise<void>>()
lines.on('line', (line) => {
  if (line.trim() === '') return
  const sending = send(line).finally(() => pending.delete(sending))
  pending.add(sending)
})
lines.on('close', () => {
  void Promise.allSettled([...pending]).then(() => process.exit(0))
})
