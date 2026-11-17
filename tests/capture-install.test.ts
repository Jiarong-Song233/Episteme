import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'

const exec = promisify(execFile)
const script = join(process.cwd(), 'scripts', 'install-capture-client.mjs')
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ep-install-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('previews without writing, then installs identical skills and a checkout launcher', async () => {
  const args = [script, '--home', directory, '--prefix', join(directory, 'bin')]
  await exec(process.execPath, [...args, '--dry-run'])
  expect(await readdir(directory)).toEqual([])
  await exec(process.execPath, args)
  const canonical = await readFile(
    join(process.cwd(), 'integrations', 'skills', 'episteme-capture', 'SKILL.md'),
    'utf8',
  )
  for (const host of ['.claude', '.agents', '.grok']) {
    expect(
      await readFile(join(directory, host, 'skills', 'episteme-capture', 'SKILL.md'), 'utf8'),
    ).toBe(canonical)
  }
  const launcher = process.platform === 'win32' ? 'ep.ps1' : 'ep'
  expect(await readFile(join(directory, 'bin', launcher), 'utf8')).toContain('packages')
})

it('refuses an unrelated destination before installing any files', async () => {
  const prefix = join(directory, 'bin')
  await mkdir(prefix)
  const launcher = process.platform === 'win32' ? 'ep.cmd' : 'ep'
  const path = join(prefix, launcher)
  await writeFile(path, 'existing personal tool')
  await expect(
    exec(process.execPath, [script, '--home', directory, '--prefix', prefix]),
  ).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('existing personal tool')
  expect(await readdir(directory)).toEqual(['bin'])
})
