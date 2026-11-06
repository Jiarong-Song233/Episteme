import OpenAI from 'openai'
import { tokenize } from './tokens.js'

/**
 * The language model behind answers, kept behind one small interface so the provider can be replaced.
 *
 * Every OpenAI-compatible service works through one client: Ollama, DeepSeek, OpenRouter, OpenAI. With nothing
 * configured the workbench runs on `SimulatedModel`, which makes no network call and says so.
 */

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface ModelReply {
  readonly text: string
  readonly tokens?: number
}

export interface ModelClient {
  readonly name: string
  /** True when no language model is involved, so a surface can say so. */
  readonly simulated: boolean
  complete(messages: readonly ModelMessage[]): Promise<ModelReply>
}

export type ModelFailureCode =
  | 'timeout'
  | 'rate_limited'
  | 'unauthorized'
  | 'unavailable'
  | 'budget_exhausted'
  | 'empty_reply'

/** A model call that did not produce a reply. Nothing the person said is lost; they can retry. */
export class ModelFailure extends Error {
  constructor(
    readonly code: ModelFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'ModelFailure'
  }

  /** Whether trying again, unchanged, could work. */
  get retryable(): boolean {
    return this.code === 'timeout' || this.code === 'rate_limited' || this.code === 'unavailable'
  }
}

export interface RemoteModelOptions {
  readonly baseUrl: string
  readonly model: string
  /** Local servers such as Ollama need none. */
  readonly apiKey?: string
  readonly timeoutMs?: number
  readonly maxOutputTokens?: number
  /** Sent as `reasoning_effort`. A local thinking model can spend its whole allowance thinking; `none` stops it. */
  readonly reasoningEffort?: string
}

function failureOf(error: unknown): ModelFailure {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new ModelFailure('timeout', '模型超时没有回应。可以重试，或换一个更快的模型。')
  }
  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError
  ) {
    return new ModelFailure('unauthorized', '模型服务拒绝了凭据。请检查 EPISTEME_MODEL_API_KEY。')
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new ModelFailure('rate_limited', '模型服务限流或额度不足。请稍后重试。')
  }
  if (error instanceof OpenAI.APIError) {
    return new ModelFailure(
      'unavailable',
      `模型服务暂时不可用（${String(error.status ?? '无响应')}）。`,
    )
  }
  throw error
}

/** Models that think aloud put it in these tags. It is not the answer. */
const THINKING = /<think>[\s\S]*?<\/think>/g

export const DEFAULT_OUTPUT_TOKENS = 2048

/** A client for any OpenAI-compatible service, with a timeout and one retry so a failure is bounded. */
export function remoteModel(options: RemoteModelOptions): ModelClient {
  const client = new OpenAI({
    baseURL: options.baseUrl,
    // The client insists on a key; a local server ignores it. Never written to a log or a response.
    apiKey: options.apiKey ?? 'not-needed',
    timeout: options.timeoutMs ?? 60_000,
    maxRetries: 1,
  })
  return {
    name: options.model,
    simulated: false,
    async complete(messages) {
      let completion: OpenAI.Chat.Completions.ChatCompletion
      try {
        completion = await client.chat.completions.create({
          model: options.model,
          messages: messages.map(({ role, content }) => ({ role, content })),
          max_tokens: options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
          temperature: 0.2,
          ...(options.reasoningEffort === undefined
            ? {}
            : {
                // Whatever the configured service accepts: providers differ on these values.
                reasoning_effort: options.reasoningEffort as OpenAI.ReasoningEffort & string,
              }),
        })
      } catch (error) {
        throw failureOf(error)
      }
      const choice = completion.choices[0]
      const text = (choice?.message.content ?? '').replace(THINKING, '').trim()
      if (text === '') {
        throw new ModelFailure(
          'empty_reply',
          choice?.finish_reason === 'length'
            ? '模型把输出额度用完了，还没写出回答，多半是都花在思考上了。请调高 EPISTEME_MODEL_MAX_OUTPUT_TOKENS，或把 EPISTEME_MODEL_REASONING_EFFORT 设为 none。'
            : '模型没有返回内容。',
        )
      }
      const tokens = completion.usage?.total_tokens
      return tokens === undefined ? { text } : { text, tokens }
    },
  }
}

/** Stops calling a model once this run has spent its allowance, so no loop or agent can spend without limit. */
export function budgeted(
  model: ModelClient,
  limits: { readonly maxCalls: number; readonly maxTokens: number },
): ModelClient & { readonly spent: () => { calls: number; tokens: number } } {
  let calls = 0
  let tokens = 0
  return {
    name: model.name,
    simulated: model.simulated,
    spent: () => ({ calls, tokens }),
    async complete(messages) {
      if (calls >= limits.maxCalls || tokens >= limits.maxTokens) {
        throw new ModelFailure(
          'budget_exhausted',
          `本次运行的模型额度已用完（${calls} 次调用，${tokens} 个 token）。重启服务，或调高 EPISTEME_MODEL_MAX_CALLS / EPISTEME_MODEL_MAX_TOKENS。`,
        )
      }
      calls += 1
      const reply = await model.complete(messages)
      tokens += reply.tokens ?? 0
      return reply
    },
  }
}

const SENTENCE = /[^。！？.!?\n]+[。！？.!?]?/g

/**
 * Answers by quoting the numbered excerpts it was given: no language model, no network.
 *
 * It does not understand anything. It exists so the workbench can be demonstrated and tested without a key, and it
 * follows the same reply format as a real model.
 */
export class SimulatedModel implements ModelClient {
  readonly name = 'simulated'
  readonly simulated = true

  complete(messages: readonly ModelMessage[]): Promise<ModelReply> {
    const last = messages.at(-1)?.content ?? ''
    const question = /<question>([\s\S]*?)<\/question>/.exec(last)?.[1] ?? ''
    const wanted = new Set(tokenize(question))
    const picks: { readonly n: string; readonly sentence: string; readonly hits: number }[] = []
    for (const match of last.matchAll(/<excerpt n="(\d+)"[^>]*>([\s\S]*?)<\/excerpt>/g)) {
      let best = { sentence: '', hits: 0 }
      for (const sentence of (match[2] ?? '').match(SENTENCE) ?? []) {
        // A heading repeats the question's words and answers nothing.
        if (sentence.trimStart().startsWith('#')) continue
        const hits = new Set(tokenize(sentence).filter((token) => wanted.has(token))).size
        if (hits > best.hits) best = { sentence: sentence.trim(), hits }
      }
      if (best.hits > 0) picks.push({ n: match[1] ?? '', ...best })
    }
    if (picks.length === 0) return Promise.resolve({ text: '[证据不足]' })
    const lines = picks
      .sort((left, right) => right.hits - left.hits)
      .slice(0, 2)
      .map(({ n, sentence }) => `${sentence}[${n}]`)
    return Promise.resolve({ text: lines.join('\n') })
  }
}

/** The model the environment configures, or the simulated one. Holds the key only inside the client. */
export function modelFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ModelClient {
  const baseUrl = environment['EPISTEME_MODEL_BASE_URL']
  const model = environment['EPISTEME_MODEL_NAME']
  if (baseUrl === undefined || baseUrl === '' || model === undefined || model === '') {
    return new SimulatedModel()
  }
  const positive = (name: string, fallback: number): number => {
    const value = Number(environment[name])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  const apiKey = environment['EPISTEME_MODEL_API_KEY']
  const reasoningEffort = environment['EPISTEME_MODEL_REASONING_EFFORT']
  return budgeted(
    remoteModel({
      baseUrl,
      model,
      ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
      ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }),
      timeoutMs: positive('EPISTEME_MODEL_TIMEOUT_MS', 60_000),
      maxOutputTokens: positive('EPISTEME_MODEL_MAX_OUTPUT_TOKENS', DEFAULT_OUTPUT_TOKENS),
    }),
    {
      maxCalls: positive('EPISTEME_MODEL_MAX_CALLS', 100),
      maxTokens: positive('EPISTEME_MODEL_MAX_TOKENS', 200_000),
    },
  )
}
