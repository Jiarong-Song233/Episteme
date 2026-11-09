#!/usr/bin/env node
/**
 * Puts what the desktop program carries into `src-tauri/resources`:
 *
 * - `app/`: the workbench as `pnpm deploy` lays it out, production dependencies only, with its built page;
 * - `node/`: the Node runtime this script runs on, so the installed program needs no Node of its own.
 *
 * The SQLite driver ships Node-API builds, which work on every Node from 22 on, so the runtime copied here does
 * not have to match the one the dependencies were installed with. Only the current platform's build is kept.
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const resources = join(here, '..', 'src-tauri', 'resources')
const app = join(resources, 'app')
const runtime = join(resources, 'node')
const windows = process.platform === 'win32'

function run(command, args) {
  process.stdout.write(`> ${command} ${args.join(' ')}\n`)
  execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: windows })
}

if (Number.parseInt(process.versions.node, 10) < 22) {
  throw new Error(
    `the program needs Node 22 or later to carry; this is Node ${process.versions.node}`,
  )
}

rmSync(resources, { recursive: true, force: true })
mkdirSync(runtime, { recursive: true })

run('pnpm', ['workbench:build'])

// `deploy` records its own settings (hoisted, production only) in the workspace's install state, after which the
// next `pnpm` command in the repository wants to remove node_modules. Put the state back as it was.
const state = join(root, 'node_modules', '.pnpm-workspace-state-v1.json')
const saved = existsSync(state) ? readFileSync(state) : undefined
try {
  run('pnpm', [
    '--filter',
    '@episteme/workbench',
    'deploy',
    '--prod',
    '--legacy',
    '--ignore-scripts',
    '--config.node-linker=hoisted',
    app,
  ])
} finally {
  if (saved !== undefined) writeFileSync(state, saved)
}

// `deploy` copies the package as it is in the repository; the page is a build output, so copy it explicitly.
const page = join(root, 'apps', 'workbench', 'web', 'dist')
rmSync(join(app, 'web'), { recursive: true, force: true })
cpSync(page, join(app, 'web', 'dist'), { recursive: true })

/** Removes what the running program never reads: sources, type declarations, maps, other platforms' drivers. */
function prune(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      prune(path)
    } else if (/\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(entry)) {
      rmSync(path)
    }
  }
}
for (const entry of ['src', 'tsconfig.json', 'tsconfig.tsbuildinfo']) {
  rmSync(join(app, entry), { recursive: true, force: true })
}
prune(app)

const sqlite = join(app, 'node_modules', 'better-sqlite3')
const keep = `${process.platform}-${process.arch}.node`
for (const entry of readdirSync(join(sqlite, 'prebuilds'))) {
  if (entry !== keep) rmSync(join(sqlite, 'prebuilds', entry))
}
if (!existsSync(join(sqlite, 'prebuilds', keep))) {
  throw new Error(`the SQLite driver has no build for ${keep}`)
}
for (const entry of ['deps', 'src', 'binding.gyp']) {
  rmSync(join(sqlite, entry), { recursive: true, force: true })
}

const node = join(runtime, windows ? 'node.exe' : 'node')
copyFileSync(process.execPath, node)
const license = join(dirname(process.execPath), 'LICENSE')
if (existsSync(license)) {
  copyFileSync(license, join(runtime, 'LICENSE'))
} else {
  const response = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
  )
  if (!response.ok) throw new Error(`could not fetch Node's licence: ${response.status}`)
  await writeFile(join(runtime, 'LICENSE'), await response.text())
}

let bytes = 0
let files = 0
;(function count(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) count(path)
    else {
      bytes += stat.size
      files += 1
    }
  }
})(resources)
process.stdout.write(
  `\nBundled Node ${process.versions.node} and the workbench into ${relative(root, resources)}: ` +
    `${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB.\n`,
)
