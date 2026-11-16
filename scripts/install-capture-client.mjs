// Install only launchers and the canonical skill; never rewrite host configuration or credentials.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    home: { type: 'string', default: homedir() },
    prefix: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
})
const home = resolve(values.home)
const prefix = resolve(
  values.prefix ??
    (process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm')
      : join(home, '.local', 'bin')),
)
const marker = 'Episteme capture client launcher'
const cli = join(root, 'packages', 'cli', 'bin', 'ep.mjs')
const skill = await readFile(
  join(root, 'integrations', 'skills', 'episteme-capture', 'SKILL.md'),
  'utf8',
)
const files = [
  ...['.claude', '.agents', '.grok'].map((host) => [
    join(home, host, 'skills', 'episteme-capture', 'SKILL.md'),
    skill,
  ]),
  ...(process.platform === 'win32'
    ? [
        [join(prefix, 'ep.cmd'), `@echo off\r\nrem ${marker}\r\nnode "${cli}" %*\r\n`],
        [
          join(prefix, 'ep.ps1'),
          `# ${marker}\n& node '${cli.replaceAll("'", "''")}' @args\nexit $LASTEXITCODE\n`,
        ],
      ]
    : [
        [
          join(prefix, 'ep'),
          `#!/bin/sh\n# ${marker}\nexec node '${cli.replaceAll("'", "'\\''")}' "$@"\n`,
        ],
      ]),
]
// Preflight every destination before writing any, to avoid partial installation over unrelated files.
for (const [path] of files) {
  const existing = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (
    existing !== undefined &&
    !existing.includes(marker) &&
    !existing.startsWith('---\nname: episteme-capture\n')
  ) {
    throw new Error(`Refusing to overwrite an unrecognised file: ${path}`)
  }
}
for (const [path, content] of files) {
  if (!values['dry-run']) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, { mode: 0o755 })
  }
  console.log(`${values['dry-run'] ? 'Would install' : 'Installed'} ${path}`)
}
console.log(`Add ${prefix} to PATH if needed. Start a new host session to discover the skill.`)
