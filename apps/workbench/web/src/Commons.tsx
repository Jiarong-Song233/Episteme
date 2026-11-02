import { useCallback, useContext, useEffect, useState, type FormEvent } from 'react'
import {
  api,
  ApiError,
  type Dimension,
  type LineageStep,
  type PublicationDetail,
  type PublicationPlan,
  type PublicationSummary,
  type PublicationUpdate,
  type PublishChoices,
  type Space,
} from './api.js'
import { Links, messageOf } from './Turns.js'

/** What people have chosen to show each other: reading it, citing it, answering it, and publishing into it. */

const whenOf = (at: number): string =>
  new Date(at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })

const RELATION_WORDS: Readonly<Record<string, string>> = {
  forks_from: '的版本',
  contradicts: '反驳',
  supports: '支持',
  evolves_to: '修正',
}

/** How a step in a lineage came from the one before it. */
const STEP_WORDS: Readonly<Record<string, string>> = {
  forks_from: '提出了自己的版本',
  contradicts: '反驳了上一条',
  supports: '支持上一条',
  evolves_to: '修正了上一条',
}

/** Refusals from publishing, in the person's terms. Anything else keeps the service's own message. */
const REFUSALS: Readonly<Record<string, string>> = {
  not_publishable: '只能发布你自己确认过的内容。',
  outside_closure: '一起发布的内容必须和这一条有关系。',
  sharing_disabled: '这个服务没有开启分享。',
  invalid_supersedes: '要替换的那一版已经不在了，可以作为新成果发布。',
  not_live: '这份成果已经撤回了。',
  own_publication: '这是你自己发布的。',
  not_the_author: '只有作者能撤回。',
}

function reasonOf(error: unknown): string {
  return error instanceof ApiError ? (REFUSALS[error.code] ?? error.message) : messageOf(error)
}

/** The first thing someone sees on a shared service: their own token, and nothing of anyone's. */
export function SignIn(props: { onSignedIn: () => void; onCancel?: () => void }) {
  const [token, setToken] = useState('')
  const [note, setNote] = useState<string>()
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setNote(undefined)
    api
      .signIn(token.trim())
      .then(props.onSignedIn)
      .catch((error: unknown) => setNote(messageOf(error)))
  }
  return (
    <main className="sign-in">
      <h1 className="wordmark">学习工作台</h1>
      <form onSubmit={submit}>
        <label>
          你的登录令牌
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <p className="hint">令牌在添加你的时候生成。没有的话，请找运行这个服务的人要一个。</p>
        {note !== undefined && (
          <p className="hint" role="alert">
            {note}
          </p>
        )}
        <p className="decisions">
          <button type="submit" disabled={token.trim() === ''}>
            登录
          </button>
          {props.onCancel !== undefined && (
            <button type="button" className="link" onClick={props.onCancel}>
              取消
            </button>
          )}
        </p>
      </form>
    </main>
  )
}

/** One wording read against another, with what went and what came marked in place. */
function diffOf(before: string, after: string) {
  const a = [...before]
  const b = [...after]
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i] as number[]
      const below = table[i + 1] as number[]
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const parts: { kind: 'same' | 'gone' | 'new'; text: string }[] = []
  const push = (kind: 'same' | 'gone' | 'new', text: string): void => {
    const last = parts[parts.length - 1]
    if (last?.kind === kind) last.text += text
    else parts.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push('same', a[i] as string)
      i += 1
      j += 1
    } else if (
      j >= b.length ||
      (i < a.length && (table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0))
    ) {
      push('gone', a[i] as string)
      i += 1
    } else {
      push('new', b[j] as string)
      j += 1
    }
  }
  return parts
}

function Difference({ before, after }: { before: string; after: string }) {
  return (
    <p className="difference">
      {diffOf(before, after).map((part, index) => {
        const key = `${index}-${part.kind}`
        if (part.kind === 'gone') return <del key={key}>{part.text}</del>
        if (part.kind === 'new') return <ins key={key}>{part.text}</ins>
        return <span key={key}>{part.text}</span>
      })}
    </p>
  )
}

/** Where an item came from, across people, oldest first. Nobody's version replaces anybody else's here. */
export function Lineage({ node, onClose }: { node: string; onClose?: () => void }) {
  const links = useContext(Links)
  const [steps, setSteps] = useState<readonly LineageStep[]>()
  const [note, setNote] = useState<string>()
  useEffect(() => {
    let current = true
    api
      .lineage(node)
      .then((reply) => {
        if (current) setSteps(reply.steps)
      })
      .catch((error: unknown) => {
        if (current) setNote(messageOf(error))
      })
    return () => {
      current = false
    }
  }, [node])
  return (
    <section className="lineage">
      <h4>谱系</h4>
      {note !== undefined && <p className="hint">{note}</p>}
      <ol>
        {steps?.map((step, index) => {
          const before = steps[index - 1]
          return (
            <li key={step.nodeId ?? step.publication}>
              {step.withdrawn === true ? (
                <p className="hint">最初的成果来自 {links.nameOf(step.author)}，已被作者撤回。</p>
              ) : (
                <>
                  {step.relation !== undefined && before?.label !== undefined && (
                    <p className="hint">
                      {links.nameOf(step.author)}
                      {STEP_WORDS[step.relation] ?? step.relation}
                      {step.reason === undefined ? '' : `：${step.reason}`}
                    </p>
                  )}
                  {step.relation === 'forks_from' &&
                  before?.label !== undefined &&
                  step.label !== undefined ? (
                    <Difference before={before.label} after={step.label} />
                  ) : (
                    <p className="lineage-label">{step.label}</p>
                  )}
                  <p className="hint">
                    {links.nameOf(step.author)}
                    {step.publication === undefined ? (
                      '，还没有发布'
                    ) : (
                      <>
                        ，
                        <button
                          type="button"
                          className="link"
                          onClick={() => links.openPublication(step.publication ?? '')}
                        >
                          看这份成果
                        </button>
                      </>
                    )}
                  </p>
                </>
              )}
            </li>
          )
        })}
      </ol>
      {onClose !== undefined && (
        <button type="button" className="link" onClick={onClose}>
          收起谱系
        </button>
      )}
    </section>
  )
}

/**
 * Publishing, in two steps: choose, then read exactly what becomes public and what does not, then confirm.
 *
 * The excerpt an item was drawn from goes with it, so it is shown here, in full, before anything leaves.
 */
export function PublishFlow(props: {
  space: string
  node: string
  fromModel: boolean
  onDone: (publication: string) => void
  onCancel: () => void
}) {
  const links = useContext(Links)
  const [choices, setChoices] = useState<PublishChoices>()
  const [include, setInclude] = useState<readonly string[]>([])
  const [supersede, setSupersede] = useState(true)
  const [note, setNote] = useState('')
  const [plan, setPlan] = useState<PublicationPlan>()
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    api
      .publishable(props.space, props.node)
      .then((reply) => {
        if (current) {
          setChoices(reply)
          setNote(reply.reason ?? '')
        }
      })
      .catch((error: unknown) => {
        if (current) setProblem(reasonOf(error))
      })
    return () => {
      current = false
    }
  }, [props.space, props.node])

  const request = {
    root: props.node,
    ...(include.length === 0 ? {} : { include }),
    ...(choices?.earlier !== undefined && supersede ? { supersedes: choices.earlier.id } : {}),
    ...(note.trim() === '' ? {} : { note: note.trim() }),
  }

  const run = (work: () => Promise<void>): void => {
    setProblem(undefined)
    setBusy(true)
    work()
      .catch((error: unknown) => setProblem(reasonOf(error)))
      .finally(() => setBusy(false))
  }

  if (choices?.published !== undefined) {
    const published = choices.published
    return (
      <section className="acting">
        <p>这一条已经发布了。</p>
        <p className="decisions">
          <button type="button" className="link" onClick={() => links.openPublication(published)}>
            看这份成果
          </button>
          <button type="button" className="link" onClick={props.onCancel}>
            取消
          </button>
        </p>
      </section>
    )
  }

  if (plan !== undefined) {
    return (
      <section className="acting publish-plan">
        <h4>发布后，已登录的人都能看到</h4>
        <ul className="will-show">
          {plan.public.nodes.map((node) => (
            <li key={node.nodeId}>
              <p>{node.label}</p>
              {node.origin?.excerpt !== undefined && node.origin.excerpt !== node.label && (
                <p className="hint">出自这段话：“{node.origin.excerpt}”</p>
              )}
            </li>
          ))}
        </ul>
        {note.trim() !== '' && <p>说明：{note.trim()}</p>}
        <p className="hint">你的名字也会显示为作者。</p>
        {props.fromModel && (
          <p className="hint" role="note">
            这一条最初是模型的话，由你确认。别人看到的是你确认过的内容，请确认你愿意为它署名。
          </p>
        )}
        <h4>仍然只有你能看到</h4>
        <p className="hint">
          其他 {plan.private.otherNodes} 条理解、你记录的把握和状态、全部对话原文、待确认的内容。
        </p>
        {problem !== undefined && (
          <p className="hint" role="alert">
            {problem}
          </p>
        )}
        <p className="decisions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const { publication } = await api.publish(request)
                props.onDone(publication.id)
              })
            }
          >
            确认发布
          </button>
          <button type="button" className="link" onClick={() => setPlan(undefined)}>
            返回修改
          </button>
          <button type="button" className="link" onClick={props.onCancel}>
            取消
          </button>
        </p>
      </section>
    )
  }

  return (
    <form
      className="acting"
      onSubmit={(event) => {
        event.preventDefault()
        run(async () => setPlan(await api.previewPublication(request)))
      }}
    >
      {choices !== undefined && choices.related.length > 0 && (
        <fieldset className="choices">
          <legend>一起发布（可不选）</legend>
          {choices.related.map((other) => (
            <label key={other.nodeId}>
              <input
                type="checkbox"
                checked={include.includes(other.nodeId)}
                onChange={(event) =>
                  setInclude((held) =>
                    event.target.checked
                      ? [...held, other.nodeId]
                      : held.filter((id) => id !== other.nodeId),
                  )
                }
              />
              {other.label}
            </label>
          ))}
        </fieldset>
      )}
      {choices?.earlier !== undefined && (
        <label className="choice">
          <input
            type="checkbox"
            checked={supersede}
            onChange={(event) => setSupersede(event.target.checked)}
          />
          作为“{choices.earlier.rootLabel}”的新版本，引用过它的人会收到提醒
        </label>
      )}
      <label>
        说明（可不填，别人能看到）
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {problem !== undefined && (
        <p className="hint" role="alert">
          {problem}
        </p>
      )}
      <p className="decisions">
        <button type="submit" disabled={busy || choices === undefined}>
          看看会公开什么
        </button>
        <button type="button" className="link" onClick={props.onCancel}>
          取消
        </button>
      </p>
    </form>
  )
}

interface CommonsProps {
  readonly me: string
  readonly spaces: readonly Space[]
  readonly current: string | undefined
  readonly dimensions: readonly Dimension[]
  readonly opened: string | undefined
  readonly onOpen: (publication: string | undefined) => void
  readonly onChanged: () => Promise<void>
  readonly onOpenNode: (space: string, node: string) => void
}

/** Everything published, newest first, and what has changed in what the person cited. */
export function Commons(props: CommonsProps) {
  const links = useContext(Links)
  const { opened, me } = props
  const [words, setWords] = useState('')
  const [query, setQuery] = useState('')
  const [author, setAuthor] = useState<string>()
  const [found, setFound] = useState<readonly PublicationSummary[]>()
  const [updates, setUpdates] = useState<readonly PublicationUpdate[]>([])
  const [note, setNote] = useState<string>()

  const load = useCallback(async () => {
    const [listed, changed] = await Promise.all([
      api.publications(query, author),
      api.publicationUpdates(),
    ])
    setFound(listed.publications)
    setUpdates(changed.updates)
    await links.refreshNames()
  }, [query, author, links.refreshNames])

  useEffect(() => {
    load().catch((error: unknown) => setNote(messageOf(error)))
  }, [load, opened])

  if (opened !== undefined) {
    return (
      <div className="page commons">
        <button type="button" className="link" onClick={() => props.onOpen(undefined)}>
          全部公开成果
        </button>
        <PublicationPage {...props} id={opened} />
      </div>
    )
  }

  return (
    <div className="page commons">
      <h2>公开成果</h2>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          setQuery(words.trim())
        }}
      >
        <input
          aria-label="搜索公开成果"
          placeholder="按内容搜索"
          value={words}
          onChange={(event) => setWords(event.target.value)}
        />
        <button type="submit">搜索</button>
      </form>
      <p className="filters">
        <button
          type="button"
          className="link"
          aria-current={author === undefined}
          onClick={() => setAuthor(undefined)}
        >
          所有人
        </button>
        <button
          type="button"
          className="link"
          aria-current={author === me}
          onClick={() => setAuthor(me)}
        >
          我的发布
        </button>
        {author !== undefined && author !== me && <span>只看 {links.nameOf(author)}</span>}
      </p>
      {note !== undefined && (
        <p className="hint" role="alert">
          {note}
        </p>
      )}

      {updates.length > 0 && (
        <section className="updates">
          <h3>你引用的内容有新版本</h3>
          <ul>
            {updates.map((update) => (
              <li key={update.newer}>
                <p>
                  {links.nameOf(update.author)} 改了：
                  {update.removed.map((node) => node.label).join('、')}
                </p>
                <p>现在是：{update.added.map((node) => node.label).join('、')}</p>
                <p className="decisions">
                  <button type="button" className="link" onClick={() => props.onOpen(update.newer)}>
                    看新版本
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      api
                        .keepCited(update.newer)
                        .then(load)
                        .catch((error: unknown) => setNote(messageOf(error)))
                    }}
                  >
                    继续用我引用的那版
                  </button>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {found?.length === 0 && (
        <p className="hint">
          {query !== ''
            ? '没有找到。试试别的词。'
            : author === me
              ? '你还没有发布过。在“我的理解”里打开一条，就可以发布它。'
              : '还没有人发布过。'}
        </p>
      )}
      <ul className="publications">
        {found?.map((publication) => (
          <li key={publication.id}>
            <button type="button" className="row" onClick={() => props.onOpen(publication.id)}>
              {publication.rootLabel}
            </button>
            <p className="hint">
              <button type="button" className="link" onClick={() => setAuthor(publication.author)}>
                {links.nameOf(publication.author)}
              </button>
              ，{whenOf(publication.createdAt)}，共 {publication.members} 条
              {publication.version > 1 ? `，第 ${publication.version} 版` : ''}
            </p>
            {publication.note !== undefined && <p className="hint">{publication.note}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}

type Answering = { readonly node: string; readonly kind: 'cite' | 'respond' }

function PublicationPage(props: CommonsProps & { id: string }) {
  const links = useContext(Links)
  const { id, me } = props
  const [read, setRead] = useState<PublicationDetail>()
  const [problem, setProblem] = useState<string>()
  const [answering, setAnswering] = useState<Answering>()
  const [lineage, setLineage] = useState<string>()
  const [arming, setArming] = useState(false)

  const load = useCallback(async () => {
    setRead(await api.publication(id))
  }, [id])

  useEffect(() => {
    setRead(undefined)
    setAnswering(undefined)
    setLineage(undefined)
    setArming(false)
    load().catch((error: unknown) => setProblem(reasonOf(error)))
  }, [load])

  if (problem !== undefined && read === undefined) return <p className="hint">{problem}</p>
  if (read === undefined) return <p className="working">正在打开…</p>

  const { publication, live } = read
  const mine = publication.actorId === me
  const version = read.versions.indexOf(publication.id) + 1
  const labelOf = (node: string): string =>
    read.nodes.find((member) => member.nodeId === node)?.label ?? ''
  const spaceName = (space: string): string =>
    props.spaces.find((candidate) => candidate.id === space)?.name ?? '另一个空间'
  // Edges that leave this publication say what it was answering, whose words those were kept with them.
  const between = read.edges.filter((edge) => labelOf(edge.from) !== '' && labelOf(edge.to) !== '')
  const answers = read.edges.filter((edge) => labelOf(edge.from) !== '' && labelOf(edge.to) === '')

  return (
    <article className="publication">
      <h2>{labelOf(publication.root)}</h2>
      <p className="hint">
        {mine ? '你' : links.nameOf(publication.actorId)} 发布于 {whenOf(publication.createdAt)}
        {read.versions.length > 1 ? `，第 ${version} 版，共 ${read.versions.length} 版` : ''}
        {live ? '' : '。已撤回，只有你还能看到'}
      </p>
      {publication.note !== undefined && <p>{publication.note}</p>}
      {read.versions.length > 1 && (
        <p className="decisions">
          {read.versions.map((other, index) => (
            <button
              key={other}
              type="button"
              className="link"
              aria-current={other === publication.id}
              onClick={() => props.onOpen(other)}
            >
              第 {index + 1} 版
            </button>
          ))}
        </p>
      )}

      {read.nodes.map((node) => {
        const cited = read.cited.find((held) => held.node === node.nodeId)
        return (
          <section key={node.nodeId} className="published-node">
            {/* The heading already says the first one. */}
            {node.nodeId !== publication.root && <p className="published-label">{node.label}</p>}
            <p className="hint">
              {node.confirmation === 'delegation'
                ? '作者授权后自动确认，作者本人没有逐条看过'
                : '作者亲自确认'}
              {node.origin?.excerpt !== undefined && node.origin.excerpt !== node.label
                ? `。出自：“${node.origin.excerpt}”`
                : ''}
            </p>
            {cited !== undefined && (
              <p className="hint">
                已引用到“{spaceName(cited.space)}”。
                <button
                  type="button"
                  className="link"
                  onClick={() => props.onOpenNode(cited.space, node.nodeId)}
                >
                  打开
                </button>
              </p>
            )}
            {live && !mine && answering?.node !== node.nodeId && (
              <p className="decisions">
                {cited === undefined && (
                  <button
                    type="button"
                    onClick={() => setAnswering({ node: node.nodeId, kind: 'cite' })}
                  >
                    引用
                  </button>
                )}
                <button
                  type="button"
                  className="link"
                  onClick={() => setAnswering({ node: node.nodeId, kind: 'respond' })}
                >
                  回应
                </button>
              </p>
            )}
            {answering?.node === node.nodeId && answering.kind === 'cite' && (
              <CiteForm
                spaces={props.spaces}
                current={props.current}
                dimensions={props.dimensions}
                onCancel={() => setAnswering(undefined)}
                onSave={async (space, dimension, level) => {
                  await api.adopt(publication.id, node.nodeId, { [dimension]: level })
                  await api.placeCited(space, publication.id, node.nodeId)
                  setAnswering(undefined)
                  await load()
                  await props.onChanged()
                }}
              />
            )}
            {answering?.node === node.nodeId && answering.kind === 'respond' && (
              <RespondForm
                original={node.label}
                spaces={props.spaces}
                current={props.current}
                onCancel={() => setAnswering(undefined)}
                onSave={async (space, label, relation, reason) => {
                  const { suggestions } = await api.respond(
                    space,
                    publication.id,
                    node.nodeId,
                    label,
                    relation,
                    reason,
                  )
                  // The person's own words and their own click: the same two decisions a revision makes.
                  for (const suggestion of suggestions) await api.accept(suggestion.id)
                  setAnswering(undefined)
                  await load()
                  await props.onChanged()
                }}
              />
            )}
          </section>
        )
      })}

      {between.length > 0 && (
        <section>
          <h3>它们之间的关系</h3>
          <ul className="relations">
            {between.map((edge) => (
              <li key={edge.id}>
                {labelOf(edge.from)}{' '}
                <span className="hint">{RELATION_WORDS[edge.type] ?? edge.type}</span>{' '}
                {labelOf(edge.to)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {answers.length > 0 && (
        <section>
          <h3>它回应的成果</h3>
          <p className="decisions">
            <button type="button" className="link" onClick={() => setLineage(answers[0]?.from)}>
              看谱系和差异
            </button>
          </p>
        </section>
      )}

      {read.responses.length > 0 && (
        <section>
          <h3>别人的回应</h3>
          <ul className="responses">
            {read.responses.map((response) => (
              <li key={`${response.publication}-${response.node}`}>
                <p>
                  <span className="hint">
                    {links.nameOf(response.author)}
                    {RELATION_WORDS[response.relation] ?? response.relation}：
                  </span>
                  {response.label}
                </p>
                {response.note !== undefined && <p className="hint">{response.note}</p>}
                <p className="decisions">
                  <button
                    type="button"
                    className="link"
                    onClick={() => props.onOpen(response.publication)}
                  >
                    看这份回应
                  </button>
                  <button type="button" className="link" onClick={() => setLineage(response.node)}>
                    看谱系和差异
                  </button>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {read.answered.length > 0 && (
        <section>
          <h3>你的回应</h3>
          <ul className="responses">
            {read.answered.map((answer) => (
              <li key={answer.node}>
                <p>
                  <span className="hint">
                    {RELATION_WORDS[answer.relation] ?? answer.relation}：
                  </span>
                  {answer.label}
                </p>
                <p className="decisions">
                  <button
                    type="button"
                    className="link"
                    onClick={() => props.onOpenNode(answer.space, answer.node)}
                  >
                    打开，可以发布
                  </button>
                  <button type="button" className="link" onClick={() => setLineage(answer.node)}>
                    看谱系和差异
                  </button>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {lineage !== undefined && <Lineage node={lineage} onClose={() => setLineage(undefined)} />}

      {problem !== undefined && (
        <p className="hint" role="alert">
          {problem}
        </p>
      )}
      {mine && live && (
        <p className="decisions withdraw">
          {arming ? (
            <>
              <span>撤回后别人就读不到了。引用过的人还留着自己的记录。</span>
              <button
                type="button"
                onClick={() => {
                  setProblem(undefined)
                  api
                    .withdrawPublication(publication.id)
                    .then(load)
                    .catch((error: unknown) => setProblem(reasonOf(error)))
                    .finally(() => setArming(false))
                }}
              >
                确认撤回
              </button>
              <button type="button" className="link" onClick={() => setArming(false)}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className="link link-danger" onClick={() => setArming(true)}>
              撤回这份成果
            </button>
          )}
        </p>
      )}
      <p className="hint">引用是私下的：谁引用了你的成果，别人和你都看不到，除非对方发布了回应。</p>
    </article>
  )
}

function SpaceChoice(props: {
  spaces: readonly Space[]
  value: string
  onChange: (space: string) => void
}) {
  return (
    <label>
      放进哪个空间
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.spaces
          .filter((space) => !space.archived)
          .map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
      </select>
    </label>
  )
}

/** Nothing here is prefilled: how sure someone is of another person's claim is theirs to say. */
function CiteForm(props: {
  spaces: readonly Space[]
  current: string | undefined
  dimensions: readonly Dimension[]
  onCancel: () => void
  onSave: (space: string, dimension: string, level: string) => Promise<void>
}) {
  const open = props.spaces.filter((space) => !space.archived)
  const [space, setSpace] = useState(props.current ?? open[0]?.id ?? '')
  const [level, setLevel] = useState('')
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  const dimension =
    props.dimensions.find((candidate) => candidate.id === 'confidence') ?? props.dimensions[0]
  if (open.length === 0 || dimension === undefined) {
    return (
      <p className="hint">
        先建一个空间，才能把它放进去。{' '}
        <button type="button" className="link" onClick={props.onCancel}>
          好
        </button>
      </p>
    )
  }
  return (
    <form
      className="acting"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setProblem(undefined)
        props
          .onSave(space, dimension.id, level)
          .catch((error: unknown) => setProblem(reasonOf(error)))
          .finally(() => setBusy(false))
      }}
    >
      <SpaceChoice spaces={props.spaces} value={space} onChange={setSpace} />
      <label>
        {dimension.labelZh}
        <select value={level} onChange={(event) => setLevel(event.target.value)}>
          <option value="">请选择</option>
          {dimension.levelLabelsZh.map((choice) => (
            <option key={choice.level} value={choice.level}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        引用不复制内容，也不改动原文。之后问到相关问题时，它会被带出来，并标明作者。
      </p>
      {problem !== undefined && (
        <p className="hint" role="alert">
          {problem}
        </p>
      )}
      <p className="decisions">
        <button type="submit" disabled={busy || level === '' || space === ''}>
          引用到这个空间
        </button>
        <button type="button" className="link" onClick={props.onCancel}>
          取消
        </button>
      </p>
    </form>
  )
}

const STANCES = [
  { id: 'forks', label: '提出我的版本' },
  { id: 'contradicts', label: '反驳' },
  { id: 'supports', label: '支持' },
] as const

function RespondForm(props: {
  original: string
  spaces: readonly Space[]
  current: string | undefined
  onCancel: () => void
  onSave: (
    space: string,
    label: string,
    relation: 'forks' | 'contradicts' | 'supports',
    reason: string,
  ) => Promise<void>
}) {
  const open = props.spaces.filter((space) => !space.archived)
  const [space, setSpace] = useState(props.current ?? open[0]?.id ?? '')
  const [relation, setRelation] = useState<(typeof STANCES)[number]['id']>('forks')
  const [label, setLabel] = useState(props.original)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  if (open.length === 0) {
    return (
      <p className="hint">
        先建一个空间，才能放你的回应。{' '}
        <button type="button" className="link" onClick={props.onCancel}>
          好
        </button>
      </p>
    )
  }
  return (
    <form
      className="acting"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setProblem(undefined)
        props
          .onSave(space, label.trim(), relation, reason.trim())
          .catch((error: unknown) => setProblem(reasonOf(error)))
          .finally(() => setBusy(false))
      }}
    >
      <fieldset className="choices choices-row">
        <legend>你想怎么回应</legend>
        {STANCES.map((stance) => (
          <label key={stance.id}>
            <input
              type="radio"
              name="stance"
              checked={relation === stance.id}
              onChange={() => {
                setRelation(stance.id)
                // A version starts from the original's words; an argument starts from the person's own.
                setLabel(stance.id === 'forks' ? props.original : '')
              }}
            />
            {stance.label}
          </label>
        ))}
      </fieldset>
      <label>
        你的说法
        <textarea rows={3} value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <label>
        为什么（可不填）
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <SpaceChoice spaces={props.spaces} value={space} onChange={setSpace} />
      <p className="hint">原作者的内容不会改变。你的回应先只有你能看到，发布后别人才看得到。</p>
      {problem !== undefined && (
        <p className="hint" role="alert">
          {problem}
        </p>
      )}
      <p className="decisions">
        <button
          type="submit"
          disabled={busy || label.trim() === '' || label.trim() === props.original}
        >
          记下我的回应
        </button>
        <button type="button" className="link" onClick={props.onCancel}>
          取消
        </button>
      </p>
    </form>
  )
}
