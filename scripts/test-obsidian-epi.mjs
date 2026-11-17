// Optional real-desktop smoke test. Uses a temporary graph and removes only its own temporary note.
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import { startService, captureProfile } from '../apps/service/dist/index.js'

const { values } = parseArgs({
  options: {
    obsidian: { type: 'string', default: 'obsidian' },
    vault: { type: 'string', default: 'Notes' },
  },
})
const exec = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), 'ep-obsidian-'))
const notePath = `00-Inbox/Episteme-smoke-${Date.now()}.md`
const service = await startService({
  port: 0,
  graph: join(directory, 'test.db'),
  profile: captureProfile(),
})
let closed = false
let attached = false
async function evaluate(code) {
  const { stdout } = await exec(
    values.obsidian,
    [`vault=${values.vault}`, 'eval', `code=${code}`],
    { timeout: 15000 },
  )
  if (stdout.includes('Error:') || stdout.includes('SyntaxError')) throw new Error(stdout)
  return stdout
}
async function api(path) {
  const r = await fetch(`${service.apiUrl}${path}`)
  assert.equal(r.status, 200)
  return r.json()
}
async function waitFor(check, description) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`Timed out: ${description}`)
}
try {
  await evaluate(
    `var p=app.plugins.plugins.episteme;if(!p)throw new Error('Episteme plugin is not enabled');window.__epiSmoke={settings:{...p.settings},file:app.workspace.getActiveFile()?.path};p.settings={...p.settings,baseUrl:${JSON.stringify(service.url)},agentToken:'',humanToken:'',scene:'dev',scope:'smoke'};await app.vault.create(${JSON.stringify(notePath)},'SQLite uses a single writer protected by a lock.');await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(${JSON.stringify(notePath)}));true`,
  )
  attached = true
  await evaluate("app.commands.executeCommandById('episteme:epi-propose');true")
  await waitFor(
    async () => (await api('/suggestions')).suggestions.length === 1,
    'propose selection through Obsidian command',
  )
  await waitFor(
    async () =>
      (await evaluate("document.querySelector('.epi-card')?.textContent ?? ''")).includes('SQLite'),
    'pending card rendered',
  )
  assert.match(
    await evaluate(
      "Array.from(document.querySelectorAll('.epi-actions button')).find(b=>b.textContent==='确认')?.disabled",
    ),
    /true/,
  )
  console.log(
    'PASS: command proposes a sourced note; review is disabled without a human credential',
  )
  await evaluate(
    `app.plugins.plugins.episteme.settings.humanToken=${JSON.stringify(service.humanToken)};await app.plugins.plugins.episteme.openPending();true`,
  )
  await evaluate(
    "Array.from(document.querySelectorAll('.epi-actions button')).find(b=>b.textContent==='确认').click();true",
  )
  await waitFor(async () => (await api('/state')).nodes.length === 1, 'accept button commits once')
  await evaluate(
    `await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(${JSON.stringify(notePath)}));app.commands.executeCommandById('episteme:epi-recall');true`,
  )
  await waitFor(
    async () =>
      (
        await evaluate(
          "document.querySelector('.workspace-leaf-content[data-type=episteme-panel]')?.textContent ?? ''",
        )
      ).includes('召回原因'),
    'recall has evidence of why it matched',
  )
  console.log('PASS: accept click and recall command show the new claim and ranking reasons')
  await evaluate(
    `await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(${JSON.stringify(notePath)}));app.workspace.activeLeaf.view.editor.setValue('SQLite transactions keep updates atomic.');app.plugins.plugins.episteme.settings.scene='learn';await app.plugins.plugins.episteme.proposeFromEditor();true`,
  )
  await waitFor(
    async () => (await api('/suggestions')).suggestions.length === 1,
    'Learn proposal in the same graph',
  )
  await evaluate(
    "Array.from(document.querySelectorAll('.epi-actions button')).find(b=>b.textContent==='驳回').click();true",
  )
  await waitFor(
    async () => (await api('/suggestions')).suggestions.length === 0,
    'reject button clears pending',
  )
  assert.equal((await api('/state')).nodes.length, 1)
  console.log('PASS: Learn proposal is rejected without changing the confirmed graph')
  await evaluate(
    `app.plugins.plugins.episteme.settings.baseUrl=${JSON.stringify('http://127.0.0.1:1')};await app.plugins.plugins.episteme.openPending();true`,
  )
  assert.match(await evaluate("document.querySelector('.epi-error')?.textContent ?? ''"), /服务/)
  console.log('PASS: unavailable service produces a visible error')
} finally {
  try {
    if (attached) {
      await evaluate(
        `var p=app.plugins.plugins.episteme;var s=window.__epiSmoke;p.settings=s.settings;var f=app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});if(f)await app.vault.delete(f);if(s.file){var old=app.vault.getAbstractFileByPath(s.file);if(old)await app.workspace.getLeaf(false).openFile(old)};var panel=app.workspace.getLeavesOfType('episteme-panel')[0];if(panel)panel.view.show('recall',null);delete window.__epiSmoke;true`,
      )
    }
  } finally {
    if (!closed) {
      await service.close()
      closed = true
    }
    await rm(directory, { recursive: true, force: true })
  }
}
