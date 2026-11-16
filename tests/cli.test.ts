import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { devProfile, startService, type EpistemeService } from '@episteme/service'
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
    profile: devProfile(),
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

  it('says what to do when the service is not there', async () => {
    const missing = await run(process.execPath, [CLI, 'reflect'], {
      env: { ...process.env, EPISTEME_URL: 'http://127.0.0.1:1', EPISTEME_TOKEN: '' },
    }).catch((error: { stderr?: string }) => ({ stdout: '', stderr: error.stderr ?? '' }))
    expect(missing.stderr).toContain('连不上服务')
  })
})
