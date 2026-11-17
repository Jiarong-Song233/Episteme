import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { captureProfile, startService, type EpistemeService } from '@episteme/service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * `ep` as a person would run it: a real child process against a real service.
 *
 * The CLI owns nothing itself; these tests are about the wire between the two, including the person's token
 * that decides and the scene route that only proposes.
 */

const run = promisify(execFile)
const CLI = join(process.cwd(), 'packages', 'cli', 'bin', 'ep.mjs')

let directory: string
let service: EpistemeService

async function ep(...args: readonly string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      EPISTEME_URL: service.url,
      EPISTEME_TOKEN: service.humanToken ?? '',
      EPISTEME_HUMAN_TOKEN: service.humanToken ?? '',
      EPISTEME_AGENT_TOKEN: '',
    },
  })
  return stdout
}

/**
 * Runs `ep` with stdin. It must be asynchronous: the service under test lives in this process, so blocking the
 * event loop would stop the HTTP server the child is waiting on.
 */
function epWithInput(
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(input)
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'episteme-cli-'))
  service = await startService({
    port: 0,
    graph: join(directory, 'dev.db'),
    profile: captureProfile(),
  })
})

afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})

describe('ep, end to end', () => {
  it('proposes a lesson, shows it pending, accepts it, and recalls it afterwards', async () => {
    const proposed = await ep('note', '用 SQLite 单文件', '--why', 'ADR 0018')
    const suggestionId = /已提议（待确认）：(\S+)/.exec(proposed)?.[1]
    expect(suggestionId).toBeTruthy()

    const pending = await ep('pending')
    expect(pending).toContain(suggestionId as string)

    const accepted = await ep('accept', suggestionId as string)
    expect(accepted).toContain('accepted')

    const notes = await ep('notes')
    expect(notes).toContain('用 SQLite 单文件')

    const reflected = await ep('reflect')
    expect(reflected).toContain('已沉淀节点')
  })

  it('turns recent commits into proposals without writing them, with --dry-run', async () => {
    const dry = await ep('distill', '--from', 'git', '-n', '1', '--dry-run')
    expect(dry).toContain('[dry-run]')
  })

  it('takes host-distilled candidates from stdin as proposals', async () => {
    const result = await epWithInput(
      ['distill', '--from', '-', '--json'],
      JSON.stringify([
        { text: '跨进程锁要放在图旁边', why: '多个进程各自锁自己的文件会互相看不见' },
      ]),
      {
        ...process.env,
        EPISTEME_URL: service.url,
        EPISTEME_AGENT_TOKEN: service.humanToken ?? '',
      },
    )
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as { proposed: { suggestionId?: string }[] }
    expect(parsed.proposed).toHaveLength(1)
    expect(typeof parsed.proposed[0]?.suggestionId).toBe('string')
  })

  it('refuses to decide without the person’s token', async () => {
    const result = await epWithInput(['accept', 'sug_anything'], '', {
      ...process.env,
      EPISTEME_URL: service.url,
      EPISTEME_TOKEN: '',
      EPISTEME_HUMAN_TOKEN: '',
      EPISTEME_AGENT_TOKEN: '',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('需要本人令牌')
  })

  it('captures Learn and discussion in the same service, and renders agreement and summaries', async () => {
    for (const scene of ['learn', 'discussion']) {
      const note = JSON.parse(
        await ep('note', `SQLite ${scene} insight`, '--scene', scene, '--json'),
      ) as { suggestionId: string }
      await ep('accept', note.suggestionId)
    }
    const notes = JSON.parse(await ep('notes', '--scene', 'discussion', '--json')) as {
      notes: { nodeId: string }[]
    }
    const id = notes.notes[0]!.nodeId
    await ep('record', id, '--set', 'agreement=partial')
    expect(await ep('notes', '--scene', 'discussion')).toContain('agreement=partial')
    expect(await ep('recall', 'SQLite', '--summary')).toContain('SQLite')
    const scoped = JSON.parse(
      await ep('recall', 'SQLite', '--scope', 'scene:learn', '--only-scope', '--json'),
    ) as { ranked: unknown[] }
    expect(scoped.ranked).toHaveLength(1)
  })

  it('verifies host quotes over MCP and keeps a correction and its contradiction', async () => {
    const text =
      'User: SQLite always allows multiple writers.\nAssistant: SQLite serializes writers using locks.'
    const input = {
      text,
      learner: 'User',
      submissionId: 'cli-test-reading',
      candidates: [
        {
          kind: 'node',
          ref: 'old',
          role: 'claim',
          label: 'SQLite always allows multiple writers',
          quote: 'SQLite always allows multiple writers',
          basis: 'stated',
          rationale: 'A position to review',
        },
        {
          kind: 'node',
          ref: 'new',
          role: 'claim',
          label: 'SQLite serializes writers using locks',
          quote: 'SQLite serializes writers using locks',
          basis: 'inferred',
          rationale: 'A correction to review',
        },
        {
          kind: 'relation',
          from: 'cand:new',
          to: 'cand:old',
          relation: 'contradicts',
          quote: 'SQLite serializes writers using locks',
          basis: 'inferred',
          rationale: 'Both positions remain visible',
        },
        {
          kind: 'node',
          ref: 'false',
          role: 'claim',
          label: 'A made-up fact',
          quote: 'This text was never said',
          basis: 'inferred',
          rationale: 'Must be refused',
        },
      ],
    }
    const env = {
      ...process.env,
      EPISTEME_URL: service.url,
      EPISTEME_HUMAN_TOKEN: '',
      EPISTEME_TOKEN: '',
      EPISTEME_AGENT_TOKEN: '',
    }
    const result = await epWithInput(
      ['distill', '--from', '-', '--scene', 'discussion', '--json'],
      JSON.stringify(input),
      env,
    )
    expect(result.status, result.stderr).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      suggestions: { id: string }[]
      refused: { code: string }[]
    }
    expect(parsed.suggestions).toHaveLength(3)
    expect(parsed.refused.some((r) => r.code === 'quote_not_found')).toBe(true)
    for (const suggestion of parsed.suggestions) await ep('accept', suggestion.id)
    const recalled = JSON.parse(await ep('recall', 'SQLite', '--json')) as { ranked: unknown[] }
    expect(recalled.ranked).toHaveLength(2)
    const again = await epWithInput(
      ['distill', '--from', '-', '--scene', 'discussion', '--json'],
      JSON.stringify(input),
      env,
    )
    expect(JSON.parse(again.stdout)).toHaveProperty('status', 'duplicate_submission')
    const pending = JSON.parse(await ep('pending', '--json')) as { suggestions: unknown[] }
    expect(pending.suggestions).toHaveLength(0)
  })

  it('validates all stdin items and leaves dry-run completely read-only', async () => {
    const env = {
      ...process.env,
      EPISTEME_URL: service.url,
      EPISTEME_HUMAN_TOKEN: '',
      EPISTEME_TOKEN: '',
      EPISTEME_AGENT_TOKEN: '',
    }
    const invalid = await epWithInput(
      ['distill', '--from', '-', '--json'],
      JSON.stringify([{ text: 'Valid note' }, { text: '' }]),
      env,
    )
    expect(invalid.status).toBe(1)
    expect(JSON.parse(invalid.stderr)).toHaveProperty('error.code', 'invalid_input')
    const dry = await epWithInput(
      ['distill', '--from', '-', '--dry-run', '--json'],
      JSON.stringify([{ text: 'A preview note' }]),
      { ...env, EPISTEME_URL: 'http://127.0.0.1:1' },
    )
    expect(dry.status).toBe(0)
    expect(JSON.parse(dry.stdout)).toHaveProperty('dryRun', true)
    const pending = JSON.parse(await ep('pending', '--json')) as { suggestions: unknown[] }
    expect(pending.suggestions).toHaveLength(0)
    expect(await ep('distill', '--from', 'git', '-n', '1', '--dry-run')).toMatch(/\[dry-run\]/)
  })

  it('keeps raw discussion turns outside the understanding graph', async () => {
    const opened = JSON.parse(
      await ep('thread', 'open', 'Database discussion', '--scene', 'discussion', '--json'),
    ) as { thread: { id: string } }
    const id = opened.thread.id
    await ep('thread', 'turn', id, 'SQLite serializes writes.', '--speaker', 'learner')
    await ep('thread', 'turn', id, 'A single writer keeps the lock.', '--speaker', 'agent')
    const raw = JSON.parse(await ep('thread', 'show', id, '--json')) as {
      turns: { text: string }[]
    }
    expect(raw.turns.map((turn) => turn.text)).toEqual([
      'SQLite serializes writes.',
      'A single writer keeps the lock.',
    ])
    const before = JSON.parse(await ep('reflect', '--json')) as { progress: { totalNodes: number } }
    expect(before.progress.totalNodes).toBe(0)
    const distilled = JSON.parse(
      await ep('thread', 'distill', id, '--scene', 'discussion', '--json'),
    ) as { sourceId: string }
    expect(typeof distilled.sourceId).toBe('string')
    const after = JSON.parse(await ep('reflect', '--json')) as { progress: { totalNodes: number } }
    expect(after.progress.totalNodes).toBe(0)
  })

  it('says what to do when the service is not there', async () => {
    const missing = await run(process.execPath, [CLI, 'reflect'], {
      env: { ...process.env, EPISTEME_URL: 'http://127.0.0.1:1', EPISTEME_TOKEN: '' },
    }).catch((error: { stderr?: string }) => ({ stdout: '', stderr: error.stderr ?? '' }))
    expect(missing.stderr).toContain('连不上服务')
  })
})
