import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  budgeted,
  DEFAULT_OUTPUT_TOKENS,
  ModelFailure,
  remoteModel,
  SimulatedModel,
  type ModelClient,
} from './model.js'

/**
 * The model the person chose on the page, kept in a small file beside the graph, and a client that follows it.
 *
 * The environment still wins: a model configured there is shown and cannot be changed from the page. The key is
 * written only to that file (owner-readable where the system supports it) and never sent back to any page.
 */

export interface SavedModel {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey?: string
  readonly reasoningEffort?: string
}

/** What a page may see of the settings: never the key itself. */
export interface ModelSettingsView {
  readonly name: string
  readonly simulated: boolean
  /** `environment`: fixed by EPISTEME_MODEL_*; `settings`: chosen on the page; `none`: the simulated model. */
  readonly source: 'environment' | 'settings' | 'none'
  readonly baseUrl?: string
  readonly model?: string
  readonly hasKey: boolean
  readonly reasoningEffort?: string
}

const LIMITS = { maxCalls: 100, maxTokens: 200_000 }
const TIMEOUT_MS = 60_000
/** A check of the connection: one short question, one short answer. */
const PROBE = [{ role: 'user' as const, content: '只回答一个字：好' }]

function clientFor(saved: SavedModel): ModelClient {
  return budgeted(
    remoteModel({
      baseUrl: saved.baseUrl,
      model: saved.model,
      ...(saved.apiKey === undefined ? {} : { apiKey: saved.apiKey }),
      ...(saved.reasoningEffort === undefined ? {} : { reasoningEffort: saved.reasoningEffort }),
      timeoutMs: TIMEOUT_MS,
      maxOutputTokens: DEFAULT_OUTPUT_TOKENS,
    }),
    LIMITS,
  )
}

function savedFrom(value: unknown): SavedModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const string = (key: string): string | undefined =>
    typeof record[key] === 'string' && record[key] !== '' ? record[key] : undefined
  const baseUrl = string('baseUrl')
  const model = string('model')
  if (baseUrl === undefined || model === undefined) return undefined
  const apiKey = string('apiKey')
  const reasoningEffort = string('reasoningEffort')
  return {
    baseUrl,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/** A model whose provider can change while the service runs. Every call goes to the current one. */
export class ModelSettings implements ModelClient {
  #client: ModelClient
  #saved: SavedModel | undefined

  private constructor(
    readonly file: string,
    readonly fromEnvironment: ModelClient | undefined,
    saved: SavedModel | undefined,
  ) {
    this.#saved = saved
    this.#client =
      fromEnvironment ?? (saved === undefined ? new SimulatedModel() : clientFor(saved))
  }

  /**
   * `fromEnvironment` is the model EPISTEME_MODEL_* configures, if any. A settings file that cannot be read is
   * ignored, so a damaged file never stops the service; saving again replaces it.
   */
  static async open(file: string, fromEnvironment?: ModelClient): Promise<ModelSettings> {
    let saved: SavedModel | undefined
    try {
      saved = savedFrom(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      saved = undefined
    }
    return new ModelSettings(file, fromEnvironment, saved)
  }

  get name(): string {
    return this.#client.name
  }

  get simulated(): boolean {
    return this.#client.simulated
  }

  complete(...args: Parameters<ModelClient['complete']>): ReturnType<ModelClient['complete']> {
    return this.#client.complete(...args)
  }

  view(): ModelSettingsView {
    if (this.fromEnvironment !== undefined) {
      return {
        name: this.name,
        simulated: this.simulated,
        source: 'environment',
        hasKey: false,
      }
    }
    const saved = this.#saved
    if (saved === undefined) {
      return { name: this.name, simulated: true, source: 'none', hasKey: false }
    }
    return {
      name: this.name,
      simulated: false,
      source: 'settings',
      baseUrl: saved.baseUrl,
      model: saved.model,
      hasKey: saved.apiKey !== undefined,
      ...(saved.reasoningEffort === undefined ? {} : { reasoningEffort: saved.reasoningEffort }),
    }
  }

  /**
   * Tries the model with one short question and keeps it only if it answers. `apiKey` undefined keeps the saved
   * key when the address is unchanged; an empty string removes it. A failure leaves everything as it was.
   */
  async save(next: {
    readonly baseUrl: string
    readonly model: string
    readonly apiKey?: string
    readonly reasoningEffort?: string
  }): Promise<ModelSettingsView> {
    if (this.fromEnvironment !== undefined) {
      throw new ModelFailure(
        'unauthorized',
        '模型由环境变量 EPISTEME_MODEL_* 指定，不能在这里修改。',
      )
    }
    const keptKey =
      next.apiKey === undefined && this.#saved?.baseUrl === next.baseUrl
        ? this.#saved.apiKey
        : next.apiKey
    const saved: SavedModel = {
      baseUrl: next.baseUrl,
      model: next.model,
      ...(keptKey === undefined || keptKey === '' ? {} : { apiKey: keptKey }),
      ...(next.reasoningEffort === undefined || next.reasoningEffort === ''
        ? {}
        : { reasoningEffort: next.reasoningEffort }),
    }
    const client = clientFor(saved)
    await client.complete(PROBE)
    await this.#write(saved)
    this.#saved = saved
    this.#client = client
    return this.view()
  }

  /** Back to the simulated model; the file and its key are removed. */
  async clear(): Promise<ModelSettingsView> {
    if (this.fromEnvironment !== undefined) {
      throw new ModelFailure(
        'unauthorized',
        '模型由环境变量 EPISTEME_MODEL_* 指定，不能在这里修改。',
      )
    }
    await rm(this.file, { force: true })
    this.#saved = undefined
    this.#client = new SimulatedModel()
    return this.view()
  }

  async #write(saved: SavedModel): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 })
    // Windows does not apply the mode; the file then keeps its folder's permissions.
    await chmod(temporary, 0o600).catch(() => undefined)
    await rename(temporary, this.file)
  }
}
