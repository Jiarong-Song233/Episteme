#!/usr/bin/env node
/**
 * The workbench's MCP tools from the command line, for an agent that runs commands but reads no MCP settings, such
 * as one given the `episteme` skill.
 *
 *   node episteme-cli.js [--url http://127.0.0.1:4322/mcp] tools
 *   node episteme-cli.js [--url …] call recall '{"question": "…"}'
 *   echo '{"question": "…"}' | node episteme-cli.js call recall -
 *
 * It reaches only this computer's workbench, and adds nothing: what it may do is what the address allows.
 */

const USAGE = `用法：
  episteme-cli [--url <地址>] tools                 列出工具和参数
  episteme-cli [--url <地址>] call <工具> <JSON|->  调用一个工具（- 表示从标准输入读参数）
地址默认是 EPISTEME_MCP_URL，或 http://127.0.0.1:4322/mcp。`

function stop(message: string, code: number): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const args = process.argv.slice(2)
let address = process.env['EPISTEME_MCP_URL'] ?? 'http://127.0.0.1:4322/mcp'
const at = args.indexOf('--url')
if (at >= 0) {
  address = args[at + 1] ?? stop(USAGE, 2)
  args.splice(at, 2)
}
if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(address)) {
  stop('只能连这台电脑上的工作台（http://127.0.0.1:…/mcp）。', 2)
}

let session: string | undefined
let next = 1

/** Sends one message and returns the answer to it, from a JSON or an event-stream reply. */
async function send(method: string, params: unknown, notification = false): Promise<unknown> {
  const id = notification ? undefined : next++
  let response: Response
  try {
    response = await fetch(address, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session === undefined ? {} : { 'mcp-session-id': session }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    stop(`连不上 Episteme 工作台，请确认它正在运行（${(error as Error).message}）。`, 3)
  }
  session = response.headers.get('mcp-session-id') ?? session
  const body = await response.text()
  if (notification) return undefined
  const messages: unknown[] = []
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data !== '') messages.push(JSON.parse(data))
    }
  } else if (body.trim() !== '') {
    const parsed = JSON.parse(body) as unknown
    messages.push(...(Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]))
  }
  const answer = messages.find((message) => (message as { id?: unknown }).id === id) as
    | { result?: unknown; error?: { message?: string } }
    | undefined
  if (answer === undefined) stop(`工作台没有回答（HTTP ${response.status}）。`, 3)
  if (answer.error !== undefined) stop(`工作台拒绝了：${answer.error.message ?? '没有说明原因'}`, 1)
  return answer.result
}

async function readInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const [command, tool, input] = args
  if (command !== 'tools' && command !== 'call') stop(USAGE, 2)
  let callArguments: unknown = {}
  if (command === 'call') {
    if (tool === undefined) stop(USAGE, 2)
    const text = input === undefined || input === '-' ? await readInput() : input
    try {
      callArguments = text.trim() === '' ? {} : JSON.parse(text)
    } catch {
      stop('参数要是一个 JSON 对象。', 2)
    }
  }
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'episteme-cli', version: '0.2.0' },
  })
  await send('notifications/initialized', {}, true)
  if (command === 'tools') {
    const { tools } = (await send('tools/list', {})) as {
      tools: {
        name: string
        description?: string
        inputSchema?: { properties?: object; required?: string[] }
      }[]
    }
    for (const listed of tools) {
      const required = new Set(listed.inputSchema?.required ?? [])
      const fields = Object.keys(listed.inputSchema?.properties ?? {}).map((name) =>
        required.has(name) ? name : `${name}?`,
      )
      process.stdout.write(
        `${listed.name}(${fields.join(', ')})\n  ${(listed.description ?? '').split('\n')[0]}\n`,
      )
    }
    return
  }
  const result = (await send('tools/call', { name: tool, arguments: callArguments })) as {
    content?: { type: string; text?: string }[]
    structuredContent?: unknown
    isError?: boolean
  }
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text' && part.text !== undefined)
    .map((part) => part.text)
    .join('\n')
  process.stdout.write(`${text || JSON.stringify(result.structuredContent ?? result, null, 2)}\n`)
  if (result.isError === true) process.exit(1)
}

void main()
