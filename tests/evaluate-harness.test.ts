import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The harness behind a published evaluation has to fail honestly. These runs use the simulated model, so they say
 * nothing about answer quality; they check that a score cannot be produced by accident and that the journey still walks.
 */

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'evaluate.mjs')

function withoutModel(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('EPISTEME_MODEL_')),
  )
}

const run = (...args: readonly string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: withoutModel(),
    timeout: 90_000,
  })

interface Row {
  readonly id: string
  readonly kind: string
  readonly score: Record<string, unknown>
  readonly answer: { readonly citations: readonly { readonly file: string }[] }
}

interface Report {
  readonly simulated: boolean
  readonly results: readonly { readonly system: string; readonly runs: readonly Row[] }[]
  readonly journey: {
    readonly tasks: readonly { readonly task: string; readonly completed: boolean }[]
  }
}

describe('the evaluation harness', () => {
  it('will not score canned answers unless told to, and then says so', async () => {
    const refused = run('--systems', 'episteme', '--repeats', '1')
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('no model configured')

    const directory = await mkdtemp(join(tmpdir(), 'episteme-evaluate-test-'))
    try {
      const out = join(directory, 'report.json')
      const done = run('--simulated', '--repeats', '1', '--out', out)
      expect(done.status).toBe(0)
      const report = JSON.parse(await readFile(out, 'utf8')) as Report
      expect(report.simulated).toBe(true)

      for (const task of report.journey.tasks) expect(task).toMatchObject({ completed: true })
      expect(report.journey.tasks.map((task) => task.task)).toEqual([
        '上传',
        '引用问答',
        '计划',
        '速通',
        '深学与练习',
        '存取理解',
        '修正',
        '跨会话复用',
        '跨身份引用',
      ])

      // A quote the model made up is not a citation, whatever it claims.
      const pasted = report.results.find((result) => result.system === 'paste-all')
      for (const row of pasted?.runs ?? []) expect(row.answer.citations).toEqual([])

      const absent = report.results[0]?.runs.find((row) => row.kind === 'absent')
      expect(absent?.score).toHaveProperty('abstained')
      expect(absent?.score).not.toHaveProperty('correct')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('does not count an answer from elsewhere as staying within the material', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'episteme-evaluate-test-'))
    try {
      const saved = join(directory, 'saved.json')
      const out = join(directory, 'rescored.json')
      const run_ = (text: string) => ({
        id: 'o1',
        kind: 'offtopic',
        repeat: 0,
        ms: 1,
        answer: { text, citations: [] },
      })
      await writeFile(
        saved,
        JSON.stringify({
          results: [
            {
              system: 'x',
              runs: [
                run_('材料里没有。'),
                run_('材料里没有相关内容，按常识回答：法国的首都是巴黎。'),
              ],
            },
          ],
        }),
      )
      const done = run('--rescore', saved, '--questions', 'questions-round-3.json', '--out', out)
      expect(done.status).toBe(0)
      const report = JSON.parse(await readFile(out, 'utf8')) as {
        results: { summary: { offtopic: { abstained: number; answeredAnyway: number } } }[]
      }
      expect(report.results[0]?.summary.offtopic).toEqual({
        n: 2,
        abstained: 1,
        answeredAnyway: 0.5,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads a citation number as the file Open WebUI numbered, not as a passage', async () => {
    const adapter = pathToFileURL(
      join(import.meta.dirname, '..', 'scripts', 'evaluate-openwebui.mjs'),
    )
    const { readAnswer } = (await import(adapter.href)) as {
      readAnswer: (body: unknown) => { citations: unknown[]; retrieved: unknown[] }
    }
    const answer = readAnswer({
      choices: [{ message: { content: '答案是 B [2]。' } }],
      sources: [
        {
          document: ['甲一', '乙', '甲二'],
          metadata: [{ source: '甲.md' }, { source: '乙.md' }, { source: '甲.md' }],
        },
      ],
    })
    expect(answer.citations).toEqual([{ file: '乙.md', quote: '乙' }])
    expect(answer.retrieved).toHaveLength(3)
  })
})
