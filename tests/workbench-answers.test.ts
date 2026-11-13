import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CognitiveSession } from '@episteme/application'
import {
  answerFrom,
  answerText,
  budgeted,
  checkReply,
  citationsOf,
  MaterialStore,
  ModelFailure,
  modelFromEnvironment,
  remoteModel,
  SimulatedModel,
  type ModelClient,
  type ModelMessage,
} from '@episteme/workbench'
import { afterEach, describe, expect, it } from 'vitest'

const simulated = new SimulatedModel()

/** A model that always says the same thing, and records what it was asked. */
function scripted(text: string): ModelClient & { calls: number } {
  const model = {
    name: 'scripted',
    simulated: false,
    calls: 0,
    complete() {
      model.calls += 1
      return Promise.resolve({ text })
    },
  }
  return model
}

async function storeWith(...materials: readonly (readonly [string, string])[]) {
  const session = await CognitiveSession.open()
  const store = await MaterialStore.open(session.sceneLog('materials'))
  for (const [title, text] of materials) {
    await store.add({ owner: 'a', space: 's', title, parsed: { kind: 'text', text }, at: 1 })
  }
  return store
}

describe('answers', () => {
  it('cites the passage that holds the answer, and says exactly where it is', async () => {
    const text = `第一行是引言。\n第二行无关。\n位置编码把序列的顺序告诉模型。\n最后一行。`
    const store = await storeWith(['编码笔记', text])
    const answer = await answerFrom({
      question: '位置编码有什么用',
      hits: store.search('a', 's', '位置编码有什么用'),
      history: [],
      model: simulated,
    })
    expect(answer.status).toBe('answered')
    expect(answer.model).toEqual({ name: 'simulated', simulated: true })
    const citation = answer.citations[0]!
    expect(citation.title).toBe('编码笔记')
    expect(text.slice(citation.start, citation.end)).toBe(citation.quote)
    expect(citation.quote).toContain('位置编码')
    expect(answer.segments[0]?.basis).toBe('material')
    expect(answer.segments[0]?.text).toContain('位置编码把序列的顺序告诉模型')
  })

  it('does not send unrelated material to the model, and does not make anything up', async () => {
    const store = await storeWith(['植物', '光合作用发生在叶绿体中。'])
    const model = scripted('编造的答案[1]')
    const answer = await answerFrom({
      question: '量子纠缠是什么',
      hits: store.search('a', 's', '量子纠缠是什么'),
      history: [],
      model,
    })
    expect(answer.status).toBe('insufficient_evidence')
    expect(answer.segments).toEqual([])
    expect(answer.citations).toEqual([])
    expect(model.calls).toBe(0)
    expect(answerText(answer)).toContain('没有找到足够的依据')
  })

  it('treats a passage that shares only a passing word as unrelated', async () => {
    const store = await storeWith(['植物', '叶绿体模型展示了光合作用。'])
    const model = scripted('编造[1]')
    const hits = store.search('a', 's', '模型 训练 优化器 梯度 损失函数')
    expect(hits.length).toBeGreaterThan(0)
    const answer = await answerFrom({
      question: '模型 训练 优化器 梯度 损失函数',
      hits,
      history: [],
      model,
    })
    expect(answer.status).toBe('insufficient_evidence')
    expect(model.calls).toBe(0)
  })

  it('opens the conversation with the person, even when the thread opened with the workbench', async () => {
    const store = await storeWith(['编码', '位置编码把顺序告诉模型。'])
    const seen: (readonly ModelMessage[])[] = []
    const answerWith = (history: readonly ModelMessage[]) =>
      answerFrom({
        question: '位置编码做什么',
        hits: store.search('a', 's', '位置编码做什么'),
        history,
        model: {
          name: 'recording',
          simulated: true,
          complete: (messages) => {
            seen.push(messages)
            return Promise.resolve({ text: '告诉模型顺序。[1]' })
          },
        },
      })
    await answerWith([{ role: 'assistant', content: '先看概览。' }])
    await answerWith([
      { role: 'user', content: '什么是编码' },
      { role: 'assistant', content: '一种表示。' },
    ])
    expect(seen[0]?.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(seen[1]?.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(seen[1]?.[1]?.content).toBe('什么是编码')
  })

  it('cites all of what the model read, so the sentence an answer rests on is never cut off', async () => {
    const late = '要找的那句话在很后面。'
    const store = await storeWith(['长文', `${'前面的铺垫内容。'.repeat(90)}${late}`])
    const hits = store.search('a', 's', '要找的那句话')
    const answer = await answerFrom({
      question: '要找的那句话',
      hits,
      history: [],
      model: scripted('在很后面。[1]'),
    })
    expect(hits[0]?.chunk.text.length).toBeGreaterThan(600)
    expect(answer.citations[0]?.quote).toContain(late)
  })

  it('reports what the model itself says it cannot answer', async () => {
    const store = await storeWith(['编码', '位置编码把顺序告诉模型。'])
    const answer = await answerFrom({
      question: '位置编码是谁发明的',
      hits: store.search('a', 's', '位置编码是谁发明的'),
      history: [],
      model: scripted('[证据不足]'),
    })
    expect(answer.status).toBe('insufficient_evidence')
  })

  it('answers across documents, citing each', async () => {
    const store = await storeWith(
      ['A', '位置编码把顺序告诉模型。'],
      ['B', '注意力机制让词元彼此关联。'],
    )
    const question = '位置编码 注意力机制'
    const answer = await answerFrom({
      question,
      hits: store.search('a', 's', question),
      history: [],
      model: simulated,
    })
    expect(answer.citations.map((citation) => citation.title).sort()).toEqual(['A', 'B'])
  })

  it('passes earlier turns to the model, and excerpts as data', async () => {
    const store = await storeWith(['A', '位置编码把顺序告诉模型。'])
    const seen: string[] = []
    const model: ModelClient = {
      name: 'm',
      simulated: false,
      complete(messages) {
        seen.push(...messages.map((message) => `${message.role}:${message.content}`))
        return Promise.resolve({ text: '好[1]' })
      },
    }
    await answerFrom({
      question: '位置编码',
      hits: store.search('a', 's', '位置编码'),
      history: [
        { role: 'user', content: '之前的问题' },
        { role: 'assistant', content: '之前的回答' },
      ],
      model,
    })
    expect(seen).toContain('user:之前的问题')
    expect(seen).toContain('assistant:之前的回答')
    expect(seen.at(-1)).toContain('<excerpt n="1"')
    expect(seen.at(-1)).toContain('<question>位置编码</question>')
  })
})

describe('checking what a model claims', () => {
  it('reads past Markdown bold, list markers and labels without calling them inference', async () => {
    const answer = checkReply(
      '**结论：** 位置编码把顺序告诉模型。[1]\n漏掉的地方：\n- 注意力本身不看顺序。[1]\n还想到什么？',
      await offered(),
      simulated,
    )
    expect(answer.segments.map(({ text, basis }) => [text, basis])).toEqual([
      ['结论：位置编码把顺序告诉模型。', 'material'],
      ['漏掉的地方：注意力本身不看顺序。', 'material'],
      ['还想到什么？', 'question'],
    ])
  })

  it('keeps what was answered when the model says only part of it is covered', async () => {
    const answer = checkReply('位置编码把顺序告诉模型。[1] [证据不足]', await offered(), simulated)
    expect(answer.status).toBe('answered')
    expect(answer.segments).toHaveLength(1)
  })

  it('still reports a trailing label as unsupported, since nothing backs it', async () => {
    const answer = checkReply('位置编码把顺序告诉模型。[1]\n另外：', await offered(), simulated)
    expect(answer.segments.at(-1)).toMatchObject({ text: '另外：', basis: 'inference' })
  })

  const offered = async () => {
    const store = await storeWith(['A', '位置编码把顺序告诉模型。'])
    return citationsOf(store.search('a', 's', '位置编码'))
  }

  it('reports a citation of an excerpt that was never offered, and does not trust that sentence', async () => {
    const answer = checkReply(
      '位置编码把顺序告诉模型。[1]\n另一个说法。[7]',
      await offered(),
      simulated,
    )
    expect(answer.invalidCitations).toEqual([7])
    expect(answer.segments[0]).toMatchObject({ basis: 'material', citations: [1] })
    expect(answer.segments[1]).toMatchObject({ basis: 'inference', citations: [] })
    expect(answer.citations.map((citation) => citation.n)).toEqual([1])
  })

  it('flags a citation that shares nothing with its sentence', async () => {
    const answer = checkReply('光合作用发生在叶绿体中。[1]', await offered(), simulated)
    expect(answer.segments[0]).toMatchObject({ basis: 'material', weak: true })
  })

  it('reports an unmarked or inferred sentence as inference', async () => {
    const answer = checkReply(
      '位置编码把顺序告诉模型。[1] 所以它很重要。[推断] 而且没有标记。',
      await offered(),
      simulated,
    )
    expect(answer.segments.map((segment) => segment.basis)).toEqual([
      'material',
      'inference',
      'inference',
    ])
    expect(answerText(answer)).toContain('所以它很重要。[推断]')
  })

  it('splits sentences so one mark does not vouch for the sentence before it', async () => {
    const answer = checkReply('前面的话。位置编码把顺序告诉模型。[1]', await offered(), simulated)
    expect(answer.segments.map((segment) => segment.basis)).toEqual(['inference', 'material'])
  })

  it('says so when nothing the model said rests on the material', async () => {
    const answer = checkReply('这是我自己的看法。', await offered(), simulated)
    expect(answer.status).toBe('inference_only')
    expect(answer.citations).toEqual([])
  })

  it('keeps a citation readable with no material behind it', async () => {
    const [citation] = await offered()
    expect((JSON.parse(JSON.stringify(citation)) as { quote: string }).quote).toContain('位置编码')
  })
})

describe('habits of a real model', () => {
  const offered = [
    {
      n: 1,
      materialId: 'm',
      title: 'a.md',
      materialVersion: 1,
      start: 10,
      end: 40,
      line: 1,
      quote: '残差连接让梯度更好传播。位置编码把顺序告诉模型。',
    },
  ]
  const model = new SimulatedModel()

  it('treats a stop after the mark as the end of that sentence, not a sentence of its own', () => {
    const answer = checkReply('位置编码把顺序告诉模型[1]。它有用[推断]。', offered, model)
    expect(answer.segments.map((segment) => [segment.text, segment.basis])).toEqual([
      ['位置编码把顺序告诉模型。', 'material'],
      ['它有用。', 'inference'],
    ])
  })

  it('points a citation at the closest sentence inside the passage', () => {
    const answer = checkReply('位置编码把顺序告诉模型。[1]', offered, model)
    const { start, end } = answer.segments[0]?.evidence?.[0] ?? { start: 0, end: 0 }
    const quote = offered[0]!.quote
    expect(quote.slice(start - 10, end - 10)).toBe('位置编码把顺序告诉模型。')
  })
})

describe('the model client', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise((resolve) => {
      if (server === undefined) resolve(undefined)
      else {
        server.closeAllConnections()
        server.close(resolve)
      }
    })
    server = undefined
  })

  /** A stand-in for an OpenAI-compatible service: the real client over real HTTP, without a real model. */
  async function serviceAnswering(
    handle: (
      body: Record<string, unknown>,
      headers: Record<string, unknown>,
    ) => {
      status: number
      body?: unknown
      hang?: boolean
    },
  ): Promise<string> {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        const reply = handle(parsed, request.headers)
        if (reply.hang === true) return
        response.writeHead(reply.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(reply.body ?? {}))
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  }

  const completion = (content: string) => ({
    id: 'x',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  })

  it('sends the model, bounds the output, passes the key, and drops thinking', async () => {
    let seen: Record<string, unknown> = {}
    let auth: unknown
    const baseUrl = await serviceAnswering((body, headers) => {
      seen = body
      auth = headers['authorization']
      return { status: 200, body: completion('<think>hmm</think>答案[1]') }
    })
    const reply = await remoteModel({ baseUrl, model: 'm', apiKey: 'sk-test' }).complete([
      { role: 'user', content: 'q' },
    ])
    expect(reply).toEqual({ text: '答案[1]', tokens: 3 })
    expect(seen['model']).toBe('m')
    expect(seen['max_tokens']).toBe(2048)
    expect(auth).toBe('Bearer sk-test')
  })

  it.each([
    [401, 'unauthorized', false],
    [429, 'rate_limited', true],
    [500, 'unavailable', true],
  ] as const)(
    'turns a %i into %s',
    async (status, code, retryable) => {
      const baseUrl = await serviceAnswering(() => ({ status, body: { error: { message: 'no' } } }))
      const failure = await remoteModel({ baseUrl, model: 'm', apiKey: 'sk-secret' })
        .complete([{ role: 'user', content: 'q' }])
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ModelFailure)
      expect((failure as ModelFailure).code).toBe(code)
      expect((failure as ModelFailure).retryable).toBe(retryable)
      expect((failure as ModelFailure).message).not.toContain('sk-secret')
    },
    20_000,
  )

  it('gives up at the timeout', async () => {
    const baseUrl = await serviceAnswering(() => ({ status: 200, hang: true }))
    const failure = await remoteModel({ baseUrl, model: 'm', timeoutMs: 100 })
      .complete([{ role: 'user', content: 'q' }])
      .catch((error: unknown) => error)
    expect((failure as ModelFailure).code).toBe('timeout')
  }, 20_000)

  it('asks once more after a blank reply, and counts both', async () => {
    let calls = 0
    const baseUrl = await serviceAnswering(() => {
      calls += 1
      return { status: 200, body: completion(calls === 1 ? '  ' : '答案[1]') }
    })
    const reply = await remoteModel({ baseUrl, model: 'm' }).complete([
      { role: 'user', content: 'q' },
    ])
    expect(reply).toEqual({ text: '答案[1]', tokens: 6 })
    expect(calls).toBe(2)
  })

  it('reports an empty reply and an unreachable service', async () => {
    let calls = 0
    const baseUrl = await serviceAnswering(() => {
      calls += 1
      return { status: 200, body: completion('  ') }
    })
    const empty = await remoteModel({ baseUrl, model: 'm' })
      .complete([{ role: 'user', content: 'q' }])
      .catch((error: unknown) => error)
    expect((empty as ModelFailure).code).toBe('empty_reply')
    // One more try, never a loop.
    expect(calls).toBe(2)
    const gone = await remoteModel({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm' })
      .complete([{ role: 'user', content: 'q' }])
      .catch((error: unknown) => error)
    expect((gone as ModelFailure).code).toBe('unavailable')
  }, 20_000)

  it('says so when a thinking model spends its allowance before answering', async () => {
    const seen: Record<string, unknown>[] = []
    const baseUrl = await serviceAnswering((body) => {
      seen.push(body)
      return {
        status: 200,
        body: {
          id: 'c',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [
            {
              index: 0,
              finish_reason: 'length',
              message: { role: 'assistant', content: '', reasoning: '首先，用户的问题是' },
            },
          ],
        },
      }
    })
    const failure = await remoteModel({
      baseUrl,
      model: 'm',
      maxOutputTokens: 200,
      reasoningEffort: 'none',
    })
      .complete([{ role: 'user', content: 'q' }])
      .catch((error: unknown) => error)
    expect((failure as ModelFailure).code).toBe('empty_reply')
    expect((failure as ModelFailure).message).toContain('EPISTEME_MODEL_REASONING_EFFORT')
    expect(seen[0]).toMatchObject({ max_tokens: 200, reasoning_effort: 'none' })
    // Asking again would spend the allowance the same way.
    expect(seen).toHaveLength(1)
  })

  it('stops calling once the budget is spent', async () => {
    const inner = scripted('好')
    const limited = budgeted(inner, { maxCalls: 2, maxTokens: 1000 })
    await limited.complete([])
    await limited.complete([])
    await expect(limited.complete([])).rejects.toMatchObject({ code: 'budget_exhausted' })
    expect(inner.calls).toBe(2)
    expect(limited.spent().calls).toBe(2)
  })

  it('uses the simulated model with nothing configured, and the configured one otherwise', () => {
    expect(modelFromEnvironment({}).simulated).toBe(true)
    expect(modelFromEnvironment({ EPISTEME_MODEL_BASE_URL: 'http://x/v1' }).simulated).toBe(true)
    const real = modelFromEnvironment({
      EPISTEME_MODEL_BASE_URL: 'http://x/v1',
      EPISTEME_MODEL_NAME: 'qwen',
    })
    expect(real.simulated).toBe(false)
    expect(real.name).toBe('qwen')
  })
})
