#!/usr/bin/env node
// ep — a thin terminal client for the Episteme REST API. See ../README.md.

import { execFileSync } from 'node:child_process'

const BASE = (process.env.EPISTEME_URL ?? 'http://127.0.0.1:4321').replace(/\/+$/, '')
const LEGACY_TOKEN = process.env.EPISTEME_TOKEN ?? ''
// An agent may read and propose. Only the person's own token decides. The legacy single token counts as
// the person's, so existing scripts keep working; an agent should be given EPISTEME_AGENT_TOKEN alone.
const HUMAN_TOKEN = process.env.EPISTEME_HUMAN_TOKEN ?? LEGACY_TOKEN
const AGENT_TOKEN = process.env.EPISTEME_AGENT_TOKEN ?? HUMAN_TOKEN

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function requireHuman(action) {
  if (!HUMAN_TOKEN) {
    fail(
      `${action}需要本人令牌：设置 EPISTEME_HUMAN_TOKEN（或 EPISTEME_TOKEN）。agent 令牌只能读取和提议。`,
    )
  }
}

async function call(path, { method = 'GET', body, as = 'agent' } = {}) {
  const token = as === 'human' ? HUMAN_TOKEN : AGENT_TOKEN
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    fail(`连不上服务 ${BASE}：${error.message}\n先启动：pnpm serve --scene dev --blank`)
  }
  const text = await response.text()
  let data
  try {
    data = text === '' ? {} : JSON.parse(text)
  } catch {
    fail(`服务返回了非 JSON（HTTP ${response.status}）：\n${text.slice(0, 400)}`)
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      fail(
        `请求失败：这个操作需要本人令牌（HTTP ${response.status}）。\n` +
          `agent 令牌可以读取和提议；确认、记录与直接写入需要 EPISTEME_HUMAN_TOKEN。`,
      )
    }
    const intent = data.intent ?? data.code ?? `HTTP ${response.status}`
    fail(`请求失败：${intent}${data.message ? ` — ${data.message}` : ''}`)
  }
  return data
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

// --- tiny arg parser: positional words + --flag value / --flag / -n value ---
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('-') && arg !== '-') {
      const name = arg.replace(/^--?/, '')
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        i += 1
      } else {
        flags[name] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function pad(value, width) {
  const s = String(value ?? '')
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function printRanked(question, data) {
  const ranked = data.ranked ?? []
  process.stdout.write(`问题：${question}\n`)
  if (ranked.length === 0) {
    process.stdout.write('（还没有与之相关的已确认理解）\n')
    return
  }
  const known = new Map((data.known ?? []).map((k) => [k.nodeId, k]))
  process.stdout.write(`${pad('score', 7)} ${pad('type', 9)} ${pad('state', 22)} 标题\n`)
  for (const item of ranked) {
    const state = (known.get(item.nodeId)?.dimensions ?? [])
      .map((d) => `${d.id}=${d.level}`)
      .join(',')
    process.stdout.write(
      `${pad(item.score?.toFixed?.(3) ?? item.score, 7)} ${pad(item.type, 9)} ${pad(state || '-', 22)} ${item.label}\n`,
    )
  }
  if (data.semanticUnavailable)
    process.stdout.write(`（这次没有按意思匹配：${data.semanticUnavailable}）\n`)
}

async function cmdRecall(pos, flags) {
  const question = pos.join(' ').trim()
  if (!question) fail('用法：ep recall <问题> [--scope 范围] [--summary] [--json]')
  const data = await call('/api/v1/recall', {
    method: 'POST',
    body: {
      question,
      ...(flags.scope ? { scope: flags.scope } : {}),
      ...(flags.summary ? { depth: 'summary' } : {}),
    },
  })
  if (flags.json) return emitJson(data)
  printRanked(question, data)
}

async function cmdReflect(flags) {
  const data = await call('/api/v1/reflect')
  if (flags.json) return emitJson(data)
  const progress = data.progress ?? {}
  process.stdout.write(
    `已沉淀节点：${progress.totalNodes ?? 0}（记录过理解的 ${progress.touched ?? 0}，已站稳 ${progress.settled ?? 0}，有未解冲突 ${progress.withOpenConflict ?? 0}）\n`,
  )
  if (progress.summaryZh) process.stdout.write(`${progress.summaryZh}\n`)
  process.stdout.write(`待确认提议：${data.pendingSuggestions ?? 0}\n`)
}

async function cmdPending(flags) {
  const data = await call('/api/v1/suggestions')
  if (flags.json) return emitJson(data)
  const list = data.suggestions ?? []
  if (list.length === 0) {
    process.stdout.write('没有待确认的提议。\n')
    return
  }
  for (const s of list) {
    const label = s.proposal?.label ?? s.proposal?.nodeType ?? s.proposal?.kind ?? '?'
    process.stdout.write(
      `- ${s.id}  [${s.proposal?.kind}] ${label}\n    理由：${s.rationale ?? ''}\n    提出者：${s.proposedBy ?? ''}\n`,
    )
  }
}

async function decide(id, action, flags) {
  if (!id) fail('用法：ep accept|reject <suggestionId> [--json]')
  requireHuman(action === 'accept' ? '确认' : '驳回')
  const data = await call('/api/v1/suggestions/decide', {
    method: 'POST',
    as: 'human',
    body: { id, action },
  })
  if (flags.json) return emitJson(data)
  const result = data.result ?? {}
  process.stdout.write(`已处理 ${id}：${result.outcome ?? action}\n`)
  if (result.nodeId) process.stdout.write(`节点：${result.nodeId}\n`)
}

async function cmdAdd(pos, flags) {
  const label = pos.join(' ').trim()
  if (!label) fail('用法：ep add <内容> [--kind claim|concept] [--scope 范围] [--json]')
  requireHuman('直接写入')
  const data = await call('/api/v1/nodes', {
    method: 'POST',
    as: 'human',
    body: {
      label,
      ...(flags.kind === 'concept' ? { kind: 'concept' } : { kind: 'claim' }),
      ...(flags.scope ? { scope: flags.scope } : {}),
    },
  })
  if (flags.json) return emitJson(data)
  process.stdout.write(`已记录：${data.node?.nodeId ?? '?'}\n`)
}

async function cmdNote(pos, flags) {
  const text = pos.join(' ').trim()
  if (!text)
    fail('用法：ep note <内容> [--why 理由] [--scope 范围] [--scene dev|discussion] [--json]')
  const scene = typeof flags.scene === 'string' ? flags.scene : 'dev'
  const data = await call(`/api/v1/scene/${scene}/notes`, {
    method: 'POST',
    body: {
      text,
      ...(flags.why ? { why: flags.why } : {}),
      ...(flags.scope ? { scope: flags.scope } : {}),
    },
  })
  if (flags.json) return emitJson(data)
  process.stdout.write(
    `已提议（待确认）：${data.suggestionId}\n用 ep pending 查看，ep accept ${data.suggestionId} 确认。\n`,
  )
}

async function cmdNotes(flags) {
  const scene = typeof flags.scene === 'string' ? flags.scene : 'dev'
  const data = await call(`/api/v1/scene/${scene}/notes`)
  if (flags.json) return emitJson(data)
  const notes = data.notes ?? []
  if (notes.length === 0) {
    process.stdout.write('还没有 dev 笔记。\n')
    return
  }
  for (const n of notes) {
    process.stdout.write(`- ${n.nodeId}  [${n.validity ?? '未记录'}] ${n.label}\n`)
  }
}

async function cmdRecord(pos, flags) {
  const target = pos[0]
  if (!target || typeof flags.set !== 'string') {
    fail('用法：ep record <nodeId> --set 维度=级别 [--reason 原因] [--json]')
  }
  const [dimension, level] = flags.set.split('=')
  if (!dimension || !level) fail('--set 需要 维度=级别，例如 validity=tested')
  requireHuman('记录理解')
  const data = await call('/api/v1/record', {
    method: 'POST',
    as: 'human',
    body: {
      target,
      dimensions: { [dimension]: level },
      ...(flags.reason ? { reason: flags.reason } : {}),
    },
  })
  if (flags.json) return emitJson(data)
  const state = (data.understanding ?? []).map((d) => `${d.id}=${d.level}`).join(',')
  process.stdout.write(`已记录 ${target}：${state || '（无变化）'}\n`)
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function proposeOne(scene, text, why, scope, flags, results) {
  const data = await call(`/api/v1/scene/${scene}/notes`, {
    method: 'POST',
    body: {
      text,
      ...(why ? { why } : {}),
      ...(scope ? { scope } : {}),
    },
  })
  results.push({ text, suggestionId: data.suggestionId })
  if (!flags.json) {
    process.stdout.write(`已提议：${text}${why ? `（${why}）` : ''} -> ${data.suggestionId}\n`)
  }
}

async function cmdDistill(pos, flags) {
  const from = flags.from
  const scene = typeof flags.scene === 'string' ? flags.scene : 'dev'
  const results = []

  if (from === '-') {
    const raw = await readStdin()
    let items
    try {
      items = JSON.parse(raw)
    } catch {
      fail('stdin 需要 JSON 数组：[{"text":"…","why":"…","scope":"…"}]')
    }
    if (!Array.isArray(items)) fail('stdin 需要 JSON 数组')
    for (const item of items) {
      if (
        item === null ||
        typeof item !== 'object' ||
        typeof item.text !== 'string' ||
        item.text.trim() === ''
      ) {
        continue
      }
      if (flags['dry-run']) {
        if (flags.json) results.push({ text: item.text, proposed: false })
        else process.stdout.write(`[dry-run] 会提议：${item.text}\n`)
        continue
      }
      await proposeOne(
        scene,
        item.text.trim(),
        typeof item.why === 'string' ? item.why : undefined,
        typeof item.scope === 'string' ? item.scope : undefined,
        flags,
        results,
      )
    }
    if (flags.json) emitJson({ proposed: results })
    else
      process.stdout.write(
        `共提议 ${results.filter((r) => r.suggestionId).length} 条，用 ep pending 查看。\n`,
      )
    return
  }

  if (from !== 'git') {
    fail('支持：ep distill --from git [-n N] [--dry-run]，或 --from -（stdin JSON）')
  }

  const n = Number.parseInt(typeof flags.n === 'string' ? flags.n : '10', 10)
  let out
  try {
    out = execFileSync(
      'git',
      ['log', `-n${Number.isFinite(n) ? n : 10}`, '--pretty=format:%h%x09%s%x09%an'],
      { encoding: 'utf8' },
    )
  } catch (error) {
    fail(`读取 git 历史失败（在当前目录运行，且需是 git 仓库）：${error.message}`)
  }
  const lines = out.split('\n').filter((line) => line.trim() !== '')
  for (const line of lines) {
    const [hash, subject, author] = line.split('\t')
    if (!subject) continue
    if (flags['dry-run']) {
      if (flags.json) results.push({ text: subject, proposed: false })
      else process.stdout.write(`[dry-run] 会提议：${subject}  （commit ${hash} by ${author}）\n`)
      continue
    }
    await proposeOne(scene, subject, `commit ${hash} by ${author}`, undefined, flags, results)
  }
  if (flags.json) emitJson({ proposed: results })
  else if (!flags['dry-run'])
    process.stdout.write(`共提议 ${results.length} 条，用 ep pending 查看。\n`)
}

function usage() {
  process.stdout.write(
    `ep — Episteme 终端客户端（先启动：pnpm serve --scene dev --blank）\n\n` +
      `  ep recall <问题> [--scope 范围] [--summary] [--json]\n` +
      `  ep reflect [--json]\n` +
      `  ep pending [--json]\n` +
      `  ep accept <id> [--json] / ep reject <id> [--json]\n` +
      `  ep add <内容> [--kind claim|concept] [--scope 范围] [--json]\n` +
      `  ep note <内容> [--why 理由] [--scope 范围] [--scene dev|discussion] [--json]\n` +
      `  ep notes [--scene dev|discussion] [--json]\n` +
      `  ep record <nodeId> --set 维度=级别 [--reason 原因] [--json]\n` +
      `  ep distill --from git [-n N] [--dry-run] [--json] [--scene dev|discussion]\n` +
      `  ep distill --from - [--dry-run] [--json] [--scene dev|discussion]   # stdin：[{"text":"…","why":"…"}]\n\n` +
      `令牌：\n` +
      `  EPISTEME_AGENT_TOKEN   读取、提议（agent 用）\n` +
      `  EPISTEME_HUMAN_TOKEN   确认、记录、直接写入（本人用；EPISTEME_TOKEN 视为它的旧名）\n` +
      `  EPISTEME_URL           默认 http://127.0.0.1:4321\n`,
  )
}

const argv = process.argv.slice(2)
const command = argv[0]
const { positional, flags } = parseArgs(argv.slice(1))

try {
  switch (command) {
    case 'recall':
      await cmdRecall(positional, flags)
      break
    case 'reflect':
      await cmdReflect(flags)
      break
    case 'pending':
      await cmdPending(flags)
      break
    case 'accept':
      await decide(positional[0], 'accept', flags)
      break
    case 'reject':
      await decide(positional[0], 'dismiss', flags)
      break
    case 'add':
      await cmdAdd(positional, flags)
      break
    case 'note':
      await cmdNote(positional, flags)
      break
    case 'notes':
      await cmdNotes(flags)
      break
    case 'record':
      await cmdRecord(positional, flags)
      break
    case 'distill':
      await cmdDistill(positional, flags)
      break
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage()
      break
    default:
      usage()
      fail(`未知命令：${command}`, 2)
  }
} catch (error) {
  fail(error?.message ?? String(error))
}
