#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { GraphLockedError } from '@episteme/application'
import { startService } from '@episteme/service'
import { modelFromEnvironment } from './model.js'
import { workbenchProfile } from './profile.js'

/** Starts the workbench: the service, its routes, and the page, on one graph file. */

const { values } = parseArgs({
  options: {
    graph: { type: 'string', short: 'g' },
    port: { type: 'string', short: 'p' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help === true) {
  process.stdout.write(
    `EPISTEME · 学习工作台\n\n  用法：pnpm workbench [--graph <文件>] [--port <端口>]\n\n` +
      `  默认图谱：~/.episteme/workbench.db；默认端口：4322。\n\n` +
      `  模型（都不设置时用模拟模型，它只摘录材料，不是真正的回答）：\n` +
      `    EPISTEME_MODEL_BASE_URL    OpenAI 兼容地址，例如 http://127.0.0.1:11434/v1\n` +
      `    EPISTEME_MODEL_NAME        模型名\n` +
      `    EPISTEME_MODEL_API_KEY     密钥，本地模型不需要\n` +
      `    EPISTEME_MODEL_TIMEOUT_MS  单次超时，默认 60000\n` +
      `    EPISTEME_MODEL_MAX_OUTPUT_TOKENS  单次输出上限，默认 2048\n` +
      `    EPISTEME_MODEL_REASONING_EFFORT   思考强度；本地思考型模型回答为空时设为 none\n` +
      `    EPISTEME_MODEL_MAX_CALLS   每次运行的调用上限，默认 100\n` +
      `    EPISTEME_MODEL_MAX_TOKENS  每次运行的 token 上限，默认 200000\n\n`,
  )
  process.exit(0)
}

const graph =
  values.graph ?? process.env['EPISTEME_FILE'] ?? join(homedir(), '.episteme', 'workbench.db')
const port = Number.parseInt(values.port ?? process.env['PORT'] ?? '4322', 10)
const page = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist')
if (!existsSync(join(page, 'index.html'))) {
  process.stderr.write('页面还没有构建。请先运行 pnpm workbench:build。\n')
  process.exit(1)
}

const model = modelFromEnvironment()
try {
  const service = await startService({
    graph,
    port,
    profile: workbenchProfile({ model }),
    workspace: page,
  })
  process.stdout.write(
    `\nEPISTEME · 学习工作台\n\n  打开：${service.workspaceUrl ?? service.url}\n  图谱：${service.graph}\n` +
      `  模型：${model.simulated ? '模拟模型（只摘录材料，不会真正回答）' : model.name}\n\n  按 Ctrl+C 停止。\n\n`,
  )
  const stop = (): void => {
    service
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} catch (error) {
  if (!(error instanceof GraphLockedError)) throw error
  process.stderr.write(`这个图谱已经被另一个进程打开了：\n  ${error.graphPath}\n`)
  process.exit(1)
}
