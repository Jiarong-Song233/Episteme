import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type Me, type ModelInfo } from './api.js'

/**
 * Choosing the language model behind answers. Saving first asks the model one short question and keeps it only if
 * it answers, so a typo shows up here and not in the middle of learning. The key never comes back to the page.
 */

interface Preset {
  readonly label: string
  readonly baseUrl: string
  readonly model: string
  readonly needsKey: boolean
}

// Addresses only; model names change too often to suggest, so each preset shows an example to replace.
const PRESETS: readonly Preset[] = [
  {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    needsKey: true,
  },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', needsKey: true },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', needsKey: true },
  { label: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: '', needsKey: false },
]

export function ModelPage(props: {
  me: Me
  model: ModelInfo | undefined
  onChanged: (model: ModelInfo) => void
}) {
  const { model } = props
  const saved = model?.source === 'settings'
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? '')
  const [name, setName] = useState(model?.model ?? '')
  const [key, setKey] = useState('')
  const [thinking, setThinking] = useState(model?.reasoningEffort === 'none')
  const [working, setWorking] = useState<'saving' | 'clearing'>()
  const [result, setResult] = useState<{ ok: boolean; text: string }>()

  // Opened by its address, the page can come before the saved settings do: fill in what is still empty.
  const savedUrl = model?.baseUrl
  const savedName = model?.model
  const savedEffort = model?.reasoningEffort
  useEffect(() => {
    if (savedUrl !== undefined) setBaseUrl((typed) => (typed === '' ? savedUrl : typed))
    if (savedName !== undefined) setName((typed) => (typed === '' ? savedName : typed))
    if (savedEffort === 'none') setThinking(true)
  }, [savedUrl, savedName, savedEffort])

  if (props.me.mode === 'shared') {
    return (
      <div className="page model">
        <h2 className="space-title">模型</h2>
        <p className="page-hint">多人模式下，模型由管理这个服务的人配置。</p>
      </div>
    )
  }

  const save = (event: FormEvent): void => {
    event.preventDefault()
    setWorking('saving')
    setResult(undefined)
    api
      .saveModel({
        baseUrl: baseUrl.trim(),
        model: name.trim(),
        // Left empty with a saved key: keep it. A different address never reuses the saved key.
        ...(key.trim() === '' ? {} : { apiKey: key.trim() }),
        reasoningEffort: thinking ? 'none' : '',
      })
      .then((reply) => {
        if ('failure' in reply) {
          setResult({ ok: false, text: `没有保存：${reply.failure.message}` })
          return
        }
        setKey('')
        setResult({
          ok: true,
          text: `已保存。${reply.model.name} 回答了测试问题，之后的回答都由它来写。`,
        })
        props.onChanged(reply.model)
      })
      .catch((error: unknown) =>
        setResult({
          ok: false,
          text: error instanceof ApiError ? error.message : '没有保存，请重试。',
        }),
      )
      .finally(() => setWorking(undefined))
  }

  const clear = (): void => {
    setWorking('clearing')
    setResult(undefined)
    api
      .clearModel()
      .then((reply) => {
        if ('failure' in reply) {
          setResult({ ok: false, text: reply.failure.message })
          return
        }
        setBaseUrl('')
        setName('')
        setKey('')
        setResult({ ok: true, text: '已改回模拟模型，保存的密钥也删除了。' })
        props.onChanged(reply.model)
      })
      .catch((error: unknown) =>
        setResult({
          ok: false,
          text: error instanceof ApiError ? error.message : '没有改动，请重试。',
        }),
      )
      .finally(() => setWorking(undefined))
  }

  return (
    <div className="page model">
      <h2 className="space-title">模型</h2>
      <p className="hint page-hint">
        回答问题、讲解和出题用的语言模型。任何兼容 OpenAI
        接口的服务都可以。材料片段和你的问题会发给这个服务。
      </p>

      <section className="panel">
        <h3>现在用的</h3>
        {model === undefined ? (
          <p className="hint">正在读取…</p>
        ) : model.simulated ? (
          <p>
            模拟模型。它只摘录材料原句，不会真正回答。配好下面的模型后，问答、讲解和出题才有意义。
          </p>
        ) : (
          <p>
            <strong>{model.name}</strong>
            {model.source === 'environment' ? '（由环境变量 EPISTEME_MODEL_* 指定）' : ''}
          </p>
        )}
      </section>

      {model?.source === 'environment' ? (
        <p className="hint">
          要在这里修改，请先去掉 EPISTEME_MODEL_BASE_URL 和 EPISTEME_MODEL_NAME，再重启服务。
        </p>
      ) : (
        <form className="panel model-form" onSubmit={save}>
          <h3>{saved ? '换一个模型' : '设置模型'}</h3>
          <div className="presets" role="group" aria-label="常用服务">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="secondary"
                onClick={() => {
                  setBaseUrl(preset.baseUrl)
                  if (preset.model !== '') setName(preset.model)
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <label>
            服务地址
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.deepseek.com"
              required
              inputMode="url"
              autoComplete="off"
            />
          </label>
          <label>
            模型名
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="deepseek-chat"
              required
              autoComplete="off"
            />
          </label>
          <label>
            密钥
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={
                saved && model?.hasKey === true && baseUrl === model.baseUrl
                  ? '已保存，留空就不改'
                  : '本机模型不需要'
              }
              autoComplete="off"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={thinking}
              onChange={(event) => setThinking(event.target.checked)}
            />
            关掉思考（本机思考型模型回答为空时勾上）
          </label>
          <div className="actions">
            <button type="submit" disabled={working !== undefined}>
              {working === 'saving' ? '正在测试…' : '测试并保存'}
            </button>
            {saved && (
              <button
                type="button"
                className="secondary"
                disabled={working !== undefined}
                onClick={clear}
              >
                {working === 'clearing' ? '正在改回…' : '改回模拟模型'}
              </button>
            )}
          </div>
          {result !== undefined && (
            <p className={result.ok ? 'hint' : 'banner banner-error'} role="status">
              {result.text}
            </p>
          )}
          <p className="hint">
            密钥只保存在这台电脑上（图谱旁边的 model.json），不会再显示在页面上，也不会给 Agent。
          </p>
        </form>
      )}
    </div>
  )
}
