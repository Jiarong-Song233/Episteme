#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  GraphLockedError,
  UnreadableGraphError,
  exportGraph,
  importGraph,
} from '@episteme/application'
import {
  addPerson,
  addToken,
  describeEmbeddings,
  EmbeddingSettingsError,
  startService,
} from '@episteme/service'
import { Agents, localAgentEnvironment } from './agents.js'
import { BUILT_IN_LIBRARY, libraryProblems, type Library } from './blocks.js'
import { modelFromEnvironment } from './model.js'
import { serviceModel } from './model-settings.js'
import { workbenchProfile } from './profile.js'

/** Starts the workbench: the service, its routes, and the page, on one graph file. */

const BUILD = '@episteme/workbench 0.1.0'

const { values, positionals } = parseArgs({
  options: {
    graph: { type: 'string', short: 'g' },
    port: { type: 'string', short: 'p' },
    shared: { type: 'boolean' },
    users: { type: 'string' },
    'public-origin': { type: 'string' },
    sharing: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
})

if (values.help === true) {
  process.stdout.write(
    `EPISTEME · 学习工作台\n\n  用法：pnpm workbench [--graph <文件>] [--port <端口>]\n\n` +
      `  默认图谱：~/.episteme/workbench.db；默认端口：4322。\n\n` +
      `  分享（默认关闭，理解只有你自己能看到）：\n` +
      `    --sharing                  允许发布已审阅的理解\n` +
      `    --shared --users <文件>     多人使用同一图谱，每人用自己的令牌登录\n` +
      `    --public-origin <地址>      别人访问这个服务用的地址，默认 http://127.0.0.1:<端口>\n` +
      `    pnpm workbench add-person <名字> --users <文件>   添加一个人并生成登录令牌（只显示一次）\n\n` +
      `  备份和恢复（先停止服务）：\n` +
      `    pnpm workbench export <文件> [--graph <文件>]   导出全部内容，含私人材料\n` +
      `    pnpm workbench import <文件> --graph <新文件>    恢复成一个新图谱，不会覆盖已有文件\n\n` +
      `  模型（都不设置时用模拟模型，它只摘录材料，不是真正的回答）：\n` +
      `    EPISTEME_MODEL_BASE_URL    OpenAI 兼容地址，例如 http://127.0.0.1:11434/v1\n` +
      `    EPISTEME_MODEL_NAME        模型名\n` +
      `    EPISTEME_MODEL_API_KEY     密钥，本地模型不需要\n` +
      `    EPISTEME_MODEL_TIMEOUT_MS  单次超时，默认 60000\n` +
      `    EPISTEME_MODEL_MAX_OUTPUT_TOKENS  单次输出上限，默认 2048\n` +
      `    EPISTEME_MODEL_REASONING_EFFORT   思考强度；本地思考型模型回答为空时设为 none\n` +
      `    EPISTEME_MODEL_MAX_CALLS   每次运行的调用上限，默认 100\n` +
      `    EPISTEME_MODEL_MAX_TOKENS  每次运行的 token 上限，默认 200000\n\n` +
      `  语义检索（默认关闭；出错时这次检索退回关键词和图谱，并写明原因）：\n` +
      `    EPISTEME_EMBEDDINGS_URL    嵌入服务地址，和下一项一起设置才开启\n` +
      `    EPISTEME_EMBEDDINGS_MODEL  嵌入模型名\n` +
      `    EPISTEME_EMBEDDINGS_PROTOCOL   openai（默认）、ollama 或 tei\n` +
      `    EPISTEME_EMBEDDINGS_API_KEY    密钥，本地服务不需要\n` +
      `    EPISTEME_EMBEDDINGS_TIMEOUT_MS 单次超时，默认 10000\n\n` +
      `  学习方式：\n` +
      `    EPISTEME_WORKFLOWS         JSON 文件，增加学习活动（blocks）和工作流（workflows）\n\n`,
  )
  process.exit(0)
}

const usersFile = values.users ?? process.env['EPISTEME_USERS']

if (positionals[0] === 'add-person') {
  const name = positionals[1]
  if (name === undefined || usersFile === undefined) {
    process.stderr.write('用法：pnpm workbench add-person <名字> --users <文件>\n')
    process.exit(1)
  }
  const actorId = await addPerson(usersFile, name)
  const token = await addToken(usersFile, actorId, 'human', 'workbench')
  process.stdout.write(`已添加：${name}\n  登录令牌（只显示这一次）：\n  ${token}\n`)
  process.exit(0)
}

const graph =
  values.graph ?? process.env['EPISTEME_FILE'] ?? join(homedir(), '.episteme', 'workbench.db')

if (positionals[0] === 'export' || positionals[0] === 'import') {
  const file = positionals[1]
  if (file === undefined || (positionals[0] === 'import' && values.graph === undefined)) {
    process.stderr.write(
      '用法：pnpm workbench export <文件> [--graph <文件>]\n      pnpm workbench import <文件> --graph <新文件>\n',
    )
    process.exit(1)
  }
  try {
    if (positionals[0] === 'export') {
      const { counts } = await exportGraph(graph, file, { build: BUILD })
      process.stdout.write(
        `已导出 ${counts.records} 条记录到 ${file}。\n这个文件含整个图谱的全部内容，包括私人材料和对话；多人使用时也包括其他人的内容。文件没有加密，请自己保管。登录令牌不在里面。\n`,
      )
    } else {
      const { counts, source, exportedAt } = await importGraph(file, graph)
      process.stdout.write(
        `已恢复到 ${graph}：${counts.records} 条记录，来自 ${source.file}（${source.build}），导出于 ${exportedAt}。\n来源和导出时间都写在文件里，校验值只能发现损坏，无法证明内容是谁写的，也无法发现有人改过。请只导入你信任的文件。\n`,
      )
    }
    process.exit(0)
  } catch (error) {
    if (error instanceof GraphLockedError) {
      process.stderr.write(`这个图谱正在被使用，请先停止服务：${error.graphPath}\n`)
    } else {
      process.stderr.write(`${(error as Error).message}\n`)
    }
    process.exit(1)
  }
}

const port = Number.parseInt(values.port ?? process.env['PORT'] ?? '4322', 10)
const page = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist')
if (values.shared === true && usersFile === undefined) {
  process.stderr.write('多人使用需要用户文件：--shared --users <文件>。\n')
  process.exit(1)
}
if (!existsSync(join(page, 'index.html'))) {
  process.stderr.write('页面还没有构建。请先运行 pnpm workbench:build。\n')
  process.exit(1)
}

/** Ways of learning added by a file: more of what `blocks.ts` holds, as data, checked before anything starts. */
async function libraryFromEnvironment(): Promise<Library> {
  const file = process.env['EPISTEME_WORKFLOWS']
  if (file === undefined || file === '') return BUILT_IN_LIBRARY
  const added = JSON.parse(await readFile(file, 'utf8')) as Partial<Library>
  const library: Library = {
    blocks: [...BUILT_IN_LIBRARY.blocks, ...(added.blocks ?? [])],
    workflows: [...BUILT_IN_LIBRARY.workflows, ...(added.workflows ?? [])],
  }
  const problems = libraryProblems(library)
  if (problems.length > 0) {
    process.stderr.write(`学习方式配置有误（${file}）：\n  ${problems.join('\n  ')}\n`)
    process.exit(1)
  }
  return library
}

// A model in the environment wins; otherwise the one chosen on the page, kept beside the graph. A shared service
// does not let anyone change it from the page: it is one model for everyone.
const fromEnvironment = modelFromEnvironment()
const { model, modelSettings } = await serviceModel({
  file: join(dirname(graph), 'model.json'),
  ...(fromEnvironment.simulated ? {} : { fromEnvironment }),
  shared: values.shared === true,
})
const library = await libraryFromEnvironment()
// Only on one person's own computer: a shared service never changes the settings of the machine it runs on.
let mcpUrl = `http://127.0.0.1:${port}/mcp`
const computer = values.shared === true ? undefined : localAgentEnvironment()
const agents =
  computer === undefined
    ? undefined
    : await Agents.open(join(dirname(graph), 'agents.json'), computer, () => mcpUrl)
try {
  const service = await startService({
    graph,
    port,
    profile: workbenchProfile({
      model,
      library,
      ...(modelSettings === undefined ? {} : { modelSettings }),
      ...(agents === undefined ? {} : { agents }),
      ...(computer === undefined ? {} : { agentEnvironment: computer }),
    }),
    ...(agents === undefined ? {} : { onMcpActivity: (activity) => agents.note(activity) }),
    workspace: page,
    ...(values.shared === true && usersFile !== undefined
      ? {
          mode: 'shared' as const,
          users: usersFile,
          publicOrigin: values['public-origin'] ?? `http://127.0.0.1:${port}`,
        }
      : {}),
    ...(values.sharing === true ? { sharing: true } : {}),
  })
  mcpUrl = service.mcpUrl
  process.stdout.write(
    `\nEPISTEME · 学习工作台\n\n  打开：${service.workspaceUrl ?? service.url}\n  图谱：${service.graph}\n` +
      `  模型：${model.simulated ? '模拟模型（只摘录材料，不会真正回答）' : model.name}\n` +
      `  ${describeEmbeddings(service.embeddings)}\n` +
      `  分享：${values.sharing === true ? '已开启，发布前都会让你确认' : '关闭'}\n\n  按 Ctrl+C 停止。\n\n`,
  )
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void agents?.flush().catch(() => undefined)
    service
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // The desktop app holds this process's input open while it runs. When the app goes away, even by crashing, the
  // input closes and the service stops with it instead of keeping the graph locked.
  if (process.env['EPISTEME_EXIT_WITH_STDIN'] === '1') {
    process.stdin.once('end', stop)
    process.stdin.once('close', stop)
    process.stdin.resume()
  }
} catch (error) {
  if (error instanceof UnreadableGraphError) {
    process.stderr.write(
      `这个版本打不开这个文件，文件没有被改动：\n  ${error.message}\n如果它是旧版图谱，可以转换成一个新文件：\n  pnpm serve graph convert <旧图谱> <新图谱>\n`,
    )
    process.exit(1)
  }
  if (error instanceof EmbeddingSettingsError) {
    process.stderr.write(`语义检索的设置有误，服务没有启动：\n  ${error.message}\n`)
    process.exit(1)
  }
  if (!(error instanceof GraphLockedError)) throw error
  process.stderr.write(`这个图谱已经被另一个进程打开了：\n  ${error.graphPath}\n`)
  process.exit(1)
}
