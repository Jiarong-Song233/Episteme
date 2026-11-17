#!/usr/bin/env node
// A graph has one owner: this client uses REST for human decisions and MCP for host readings.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const BASE = (process.env.EPISTEME_URL ?? 'http://127.0.0.1:4321').replace(/\/+$/, '')
const HUMAN = process.env.EPISTEME_HUMAN_TOKEN ?? process.env.EPISTEME_TOKEN ?? ''
const AGENT = process.env.EPISTEME_AGENT_TOKEN ?? HUMAN
const CLIENT = process.env.EPISTEME_CLIENT ?? 'ep-cli'
const SCENES = ['dev', 'learn', 'discussion']
const jsonOutput = process.argv.includes('--json')

class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
function fail(code, message) {
  throw new CliError(code, message)
}
function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
function output(value, text) {
  if (jsonOutput) emit(value)
  else process.stdout.write(`${text}\n`)
}

async function request(path, method = 'GET', body, human = false, extra = {}) {
  const token = human ? HUMAN : AGENT
  if (human && !token)
    fail(
      'human_token_required',
      '这个操作需要本人令牌 EPISTEME_HUMAN_TOKEN；agent 只能读取和提议。',
    )
  let response
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: 'application/json, text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    fail('service_unavailable', `连不上服务 ${BASE}：${error.message}`)
  }
  const text = await response.text()
  let data
  try {
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      data = text
        .split(/\r?\n\r?\n/)
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n'),
        )
        .filter(Boolean)
        .map((part) => JSON.parse(part))
        .find((part) => part.id === 1)
    } else data = text ? JSON.parse(text) : {}
  } catch {
    fail('invalid_response', `服务返回非 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok)
    fail(
      data.code ?? `http_${response.status}`,
      data.message ?? data.error ?? `HTTP ${response.status}`,
    )
  return data
}

async function mcp(name, args) {
  const protocol = '2026-07-28'
  const body = await request(
    `/mcp?client=${encodeURIComponent(CLIENT)}`,
    'POST',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocol,
          'io.modelcontextprotocol/clientInfo': { name: CLIENT, version: '0.2.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
    false,
    { 'mcp-protocol-version': protocol, 'mcp-method': 'tools/call', 'mcp-name': name },
  )
  if (body?.error) fail('mcp_error', body.error.message)
  const result = body?.result
  if (!result) fail('invalid_response', 'MCP response has no result')
  if (result.isError)
    fail(
      result.structuredContent?.code ?? 'proposal_refused',
      result.content?.map((entry) => entry.text ?? '').join('\n') ?? 'Proposal refused',
    )
  return result.structuredContent ?? result
}

function selectedScene(flags) {
  const scene = flags.scene ?? process.env.EPISTEME_SCENE ?? 'dev'
  if (!SCENES.includes(scene)) fail('invalid_scene', '场景可选 dev / learn / discussion')
  return scene
}
function scoped(scene, scope) {
  const prefix = `scene:${scene}`
  if (!scope) return prefix
  if (scope.startsWith('scene:')) {
    if (scope !== prefix && !scope.startsWith(`${prefix}:`))
      fail('invalid_scope', `scope 应属于 ${prefix}`)
    return scope
  }
  return `${prefix}:${scope}`
}
async function notesPath(scene) {
  const state = await request('/api/v1/state')
  if (state.scene === 'capture') return `/api/v1/scene/capture/${scene}/notes`
  if (state.scene === scene || (scene === 'learn' && state.scene === 'default'))
    return `/api/v1/scene/${state.scene}/notes`
  fail(
    'scene_mismatch',
    `当前服务是 ${state.scene} 场景；请用 --scene capture 启动服务以共用图谱。`,
  )
}
function words(pos, message) {
  const text = pos.join(' ').trim()
  if (!text) fail('invalid_arguments', message)
  return text
}
async function stdinJson() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 1024 * 1024) fail('input_too_large', 'stdin must be at most 1 MB')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks)
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    )
  } catch {
    fail('invalid_input', 'stdin 需要 JSON：候选数组或带 text / candidates 的来源对象。')
  }
}
function validateNote(item) {
  if (
    !item ||
    typeof item.text !== 'string' ||
    item.text.trim().length < 2 ||
    item.text.trim().length > 1000
  ) {
    fail('invalid_input', '每条 note 需为 2–1000 字符；长文本请用带 text / candidates 的来源对象。')
  }
  for (const key of ['why', 'scope', 'source'])
    if (item[key] !== undefined && typeof item[key] !== 'string')
      fail('invalid_input', `${key} must be a string`)
}
async function proposeNote(scene, item) {
  return request(await notesPath(scene), 'POST', {
    ...item,
    text: item.text.trim(),
    scope: scoped(scene, item.scope),
  })
}

async function run(command, pos, flags) {
  const scene = selectedScene(flags)
  switch (command) {
    case 'recall': {
      const question = words(
        pos,
        'ep recall <问题> [--scope 范围] [--only-scope] [--summary] [--json]',
      )
      const scope = flags.scope
        ? flags.scene
          ? scoped(scene, flags.scope)
          : flags.scope
        : flags['only-scope']
          ? scoped(scene)
          : undefined
      let data = await request('/api/v1/recall', 'POST', {
        question,
        ...(scope ? { scope } : {}),
        ...(flags.summary ? { depth: 'summary' } : {}),
      })
      if (flags['only-scope']) {
        const state = await request('/api/v1/state')
        const ids = new Set(
          state.nodes
            .filter((node) => node.tags.includes(`scope:${scope}`))
            .map((node) => node.nodeId),
        )
        data = {
          ...data,
          scope,
          filteredWindow: true,
          ...(data.entries
            ? { entries: data.entries.filter((entry) => ids.has(entry.nodeId)) }
            : {}),
          ...(data.ranked
            ? {
                ranked: data.ranked.filter((entry) => ids.has(entry.nodeId)),
                known: data.known.filter((entry) => ids.has(entry.nodeId)),
              }
            : {}),
        }
      }
      if (jsonOutput) return emit(data)
      process.stdout.write(`问题：${question}\n`)
      const entries = data.entries ?? data.ranked ?? []
      if (!entries.length) process.stdout.write('（当前召回窗口没有相关理解）\n')
      for (const entry of entries) {
        const state =
          entry.state ??
          (data.known?.find((node) => node.nodeId === entry.nodeId)?.dimensions ?? [])
            .map((d) => `${d.id}=${d.level}`)
            .join(', ')
        process.stdout.write(`- ${entry.nodeId} [${state || '未记录状态'}] ${entry.label}\n`)
        if (entry.reasons) process.stdout.write(`  ${JSON.stringify(entry.reasons)}\n`)
      }
      if (flags['only-scope'])
        process.stdout.write('已对有限召回窗口按 scope 精确筛选；窗口外的命中可能未显示。\n')
      if (data.semanticUnavailable)
        process.stdout.write(`语义检索不可用：${data.semanticUnavailable}\n`)
      return
    }
    case 'reflect': {
      const data = await request('/api/v1/reflect')
      return output(
        data,
        `已沉淀节点：${data.progress.totalNodes}\n${data.progress.summaryZh}\n待确认提议：${data.pendingSuggestions}`,
      )
    }
    case 'pending': {
      const data = await request('/api/v1/suggestions')
      return output(
        data,
        data.suggestions
          .map(
            (s) =>
              `- ${s.id} [${s.proposal.kind}] ${s.proposal.label ?? JSON.stringify(s.proposal)}\n  ${s.rationale}\n  来源：${s.origin?.excerpt ?? '无原文'}；提出者：${s.proposedBy}`,
          )
          .join('\n') || '没有待确认的提议。',
      )
    }
    case 'accept':
    case 'reject': {
      if (pos.length !== 1) fail('invalid_arguments', 'ep accept|reject <suggestionId>')
      const data = await request(
        '/api/v1/suggestions/decide',
        'POST',
        { id: pos[0], action: command === 'accept' ? 'accept' : 'dismiss' },
        true,
      )
      return output(data, `已处理 ${pos[0]}：${data.result.outcome}`)
    }
    case 'add': {
      const label = words(pos, 'ep add <本人内容>')
      if (flags.kind && !['concept', 'claim'].includes(flags.kind))
        fail('invalid_arguments', 'kind must be claim or concept')
      const data = await request(
        '/api/v1/nodes',
        'POST',
        { label, kind: flags.kind ?? 'claim' },
        true,
      )
      return output(data, `已记录：${data.node.nodeId}`)
    }
    case 'note': {
      const item = {
        text: words(pos, 'ep note <内容> [--scene dev|learn|discussion]'),
        ...(flags.why ? { why: flags.why } : {}),
        ...(flags.scope ? { scope: flags.scope } : {}),
        ...(flags.source ? { source: flags.source } : {}),
      }
      validateNote(item)
      const data = await proposeNote(scene, item)
      return output(data, `已提议（待确认）：${data.suggestionId}`)
    }
    case 'notes': {
      const path = await notesPath(scene)
      const data = await request(
        path + (flags.scope ? `?scope=${encodeURIComponent(scoped(scene, flags.scope))}` : ''),
      )
      return output(
        data,
        data.notes
          .map(
            (n) =>
              `- ${n.nodeId} [${n.dimensions.map((d) => `${d.id}=${d.level}`).join(', ') || '未记录'}] ${n.label}`,
          )
          .join('\n') || '还没有笔记。',
      )
    }
    case 'record': {
      const match = /^([^=]+)=([^=]+)$/.exec(flags.set ?? '')
      if (pos.length !== 1 || !match)
        fail('invalid_arguments', 'ep record <nodeId> --set dimension=level')
      const data = await request(
        '/api/v1/record',
        'POST',
        {
          target: pos[0],
          dimensions: { [match[1]]: match[2] },
          ...(flags.reason ? { reason: flags.reason } : {}),
        },
        true,
      )
      return output(
        data,
        `已记录 ${pos[0]}：${data.understanding.map((d) => `${d.id}=${d.level}`).join(', ')}`,
      )
    }
    case 'distill': {
      if (flags.from === '-') {
        const input = await stdinJson()
        if (!Array.isArray(input)) {
          if (
            !input ||
            typeof input.text !== 'string' ||
            !input.text.trim() ||
            !Array.isArray(input.candidates)
          )
            fail('invalid_input', '来源对象必须含 text 和 candidates 数组')
          if (
            !input.candidates.length ||
            input.candidates.some(
              (c) =>
                !c ||
                typeof c.quote !== 'string' ||
                !c.quote.trim() ||
                !['node', 'relation', 'state'].includes(c.kind),
            )
          )
            fail('invalid_input', '每个候选需 kind、quote；candidates 不能为空')
          const payload = { ...input, scope: scoped(scene, input.scope ?? flags.scope) }
          if (flags['dry-run'])
            return output(
              { dryRun: true, payload },
              `预览：${input.candidates.length} 个带原文的候选（未写入）`,
            )
          const data = await mcp('distill', payload)
          return output(
            data,
            `已提议 ${data.suggestions?.length ?? 0} 条；拒绝 ${data.refused?.length ?? 0} 条\n${JSON.stringify(data.refused ?? [])}`,
          )
        }
        // Validate the whole batch before the first request, so an invalid tail cannot cause a partial write.
        for (const item of input) {
          validateNote(item)
          scoped(scene, item.scope ?? flags.scope)
        }
        if (flags['dry-run'])
          return output(
            { dryRun: true, proposed: input },
            input.map((i) => `[dry-run] 会提议：${i.text}`).join('\n'),
          )
        const proposed = []
        for (const item of input)
          proposed.push({
            text: item.text,
            ...(await proposeNote(scene, { ...item, scope: item.scope ?? flags.scope })),
          })
        return output({ proposed }, `共提议 ${proposed.length} 条，用 ep pending 查看。`)
      }
      if (flags.from !== 'git')
        fail('invalid_arguments', 'ep distill --from git|- [--dry-run] [--json]')
      const n = Number(flags.n ?? 10)
      if (!Number.isInteger(n) || n < 1 || n > 100)
        fail('invalid_arguments', '-n must be an integer from 1 to 100')
      let history
      try {
        history = execFileSync('git', ['log', `-n${n}`, '--format=%H%x09%s%x09%an'], {
          encoding: 'utf8',
          timeout: 10000,
        })
      } catch {
        fail('git_unavailable', '当前目录需为可读的 Git 仓库')
      }
      const items = history
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, text, author] = line.split('\t')
          return {
            text,
            why: `Mechanical commit capture by ${author}; review before accepting as a lesson`,
            source: `git:${hash}`,
            scope: flags.scope,
          }
        })
      for (const item of items) validateNote(item)
      if (flags['dry-run'])
        return output(
          { dryRun: true, proposed: items },
          items.map((i) => `[dry-run] 会提议：${i.text}`).join('\n'),
        )
      const proposed = []
      for (const item of items)
        proposed.push({ text: item.text, ...(await proposeNote(scene, item)) })
      return output({ proposed }, `共提议 ${proposed.length} 条，用 ep pending 查看。`)
    }
    case 'thread': {
      const [action, id] = pos
      if (action === 'open') {
        const data = await request('/api/v1/threads', 'POST', {
          title: words(pos.slice(1), 'ep thread open <标题>'),
          scope: scoped(scene, flags.scope),
        })
        return output(data, `讨论线程：${data.thread.id}`)
      }
      if (action === 'show' && id) {
        const data = await request(`/api/v1/threads/${encodeURIComponent(id)}`)
        return output(data, JSON.stringify(data, null, 2))
      }
      if (action === 'turn' && id) {
        if (!['learner', 'agent'].includes(flags.speaker))
          fail('invalid_arguments', 'ep thread turn <id> <原文> --speaker learner|agent')
        const data = await request(`/api/v1/threads/${encodeURIComponent(id)}/turns`, 'POST', {
          speaker: flags.speaker,
          text: words(pos.slice(2), 'turn needs text'),
        })
        return output(data, `已存原文：${data.turn.id}（未确认理解）`)
      }
      if (action === 'distill' && id) {
        if (flags['dry-run'])
          return output({ dryRun: true, thread: id }, `将提炼线程 ${id}（未写入）`)
        const data = await request('/api/v1/distill', 'POST', {
          thread: id,
          scope: scoped(scene, flags.scope),
        })
        return output(data, `已提议 ${data.suggestions.length} 条；原文保留在线程中`)
      }
      fail('invalid_arguments', 'ep thread open|show|turn|distill ...')
      break
    }
    case undefined:
    case 'help':
      return help()
    default:
      fail('invalid_arguments', `未知命令：${command}`)
  }
}
function help() {
  output(
    {
      commands: [
        'recall',
        'reflect',
        'note',
        'notes',
        'pending',
        'accept',
        'reject',
        'add',
        'record',
        'distill',
        'thread',
      ],
    },
    `ep · Episteme 终端客户端\n启动：pnpm serve --scene capture --blank\n\n` +
      `ep recall <问题> [--scope scene:dev:project] [--only-scope] [--summary]\n` +
      `ep note <内容> [--scene dev|learn|discussion] [--scope project] [--source 路径] [--why 理由]\n` +
      `ep add <本人内容> [--kind claim|concept]\n` +
      `ep notes [--scene ...] [--scope ...]\nep pending | reflect\nep accept|reject <id>\nep record <nodeId> --set dimension=level\n` +
      `ep distill --from git [-n 1..100] [--dry-run]\nep distill --from - [--scene ...] [--dry-run]\n` +
      `ep thread open <标题> | show <id> | turn <id> <原文> --speaker learner|agent | distill <id>\n` +
      `所有命令支持 --json；读取/提议用 EPISTEME_AGENT_TOKEN（本地可留空），确认用 EPISTEME_HUMAN_TOKEN。\n`,
  )
}
try {
  const args = process.argv.slice(2).filter((arg) => arg !== '--json')
  if (args[0] === '--help' || args[0] === '-h') args[0] = 'help'
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: {
      scene: { type: 'string' },
      scope: { type: 'string' },
      summary: { type: 'boolean' },
      'only-scope': { type: 'boolean' },
      why: { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string' },
      set: { type: 'string' },
      reason: { type: 'string' },
      from: { type: 'string' },
      n: { type: 'string', short: 'n' },
      'dry-run': { type: 'boolean' },
      speaker: { type: 'string' },
    },
  })
  await run(args[0], positionals, values)
} catch (error) {
  const code = error.code ?? 'cli_error'
  if (jsonOutput)
    process.stderr.write(`${JSON.stringify({ error: { code, message: error.message } })}\n`)
  else process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
