import { execFile } from 'node:child_process'
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

  it('says what to do when the service is not there', async () => {
    const missing = await run(process.execPath, [CLI, 'reflect'], {
      env: { ...process.env, EPISTEME_URL: 'http://127.0.0.1:1', EPISTEME_TOKEN: '' },
    }).catch((error: { stderr?: string }) => ({ stdout: '', stderr: error.stderr ?? '' }))
    expect(missing.stderr).toContain('连不上服务')
  })
})
