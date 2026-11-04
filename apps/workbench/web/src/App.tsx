import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  api,
  ApiError,
  type BlockInfo,
  type Citation,
  type Evidence,
  type Failure,
  type MaterialSummary,
  type MaterialText,
  type Me,
  type PendingCandidate,
  type Plan,
  type Session,
  type Space,
  type Turn,
  type Understanding,
  type WorkflowInfo,
} from './api.js'
import { Commons, SignIn } from './Commons.js'
import { PlanShelf, PlanView, StatusView } from './Learning.js'
import { Outcomes } from './Outcomes.js'
import { AgentTurn, LearnerTurn, Links, messageOf } from './Turns.js'
import { UnderstandingPanel, wordsOf } from './Understanding.js'

type SideTab = 'source' | 'pending' | 'understood' | 'status'
type Pane = 'shelf' | 'talk' | 'side'

const LAST_SPACE = 'workbench.space'

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_SPACE)
  } catch {
    return null
  }
}

function remember(space: string): void {
  try {
    localStorage.setItem(LAST_SPACE, space)
  } catch {
    // Only a convenience: the page opens on the first space instead.
    return
  }
}

const NO_UNDERSTANDING: Understanding = { nodes: [], pending: [], challenges: [], dimensions: [] }
/** A jump to a turn waits for the conversation it lies in to load, up to this many tries, 100 ms apart. */
const FOCUS_TRIES = 30

/** What the source panel shows: a material, and the passage a citation points at, if any. */
interface SourceRequest {
  readonly materialId: string
  readonly title: string
  readonly citation?: Citation
  /** The closest sentence inside the cited passage, when the answer found one. */
  readonly evidence?: Evidence
}

export function App() {
  const [me, setMe] = useState<Me>()
  const [signingIn, setSigningIn] = useState(false)
  const [problem, setProblem] = useState<string>()

  const enter = useCallback(() => {
    setProblem(undefined)
    api
      .me()
      .then((found) => {
        setMe(found)
        setSigningIn(false)
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'signed_out') setSigningIn(true)
        else setProblem(messageOf(error))
      })
  }, [])

  useEffect(enter, [enter])

  if (signingIn) {
    return (
      <SignIn
        onSignedIn={enter}
        {...(me === undefined ? {} : { onCancel: () => setSigningIn(false) })}
      />
    )
  }
  if (problem !== undefined) {
    return (
      <p className="banner banner-error" role="alert">
        {problem}
      </p>
    )
  }
  if (me === undefined) return null
  return (
    // Everything held on the page is one person's, so changing person starts it over.
    <Desk key={me.actorId} me={me} onNames={setMe} onSignIn={() => setSigningIn(true)} />
  )
}

function Desk({
  me,
  onNames,
  onSignIn,
}: {
  me: Me
  onNames: (me: Me) => void
  onSignIn: () => void
}) {
  const [commons, setCommons] = useState(false)
  const [publication, setPublication] = useState<string>()
  /** A node to open once the space it lies in has loaded, because changing space clears the selection. */
  const nodeAfterSwitch = useRef<string | undefined>(undefined)
  const [model, setModel] = useState<{ name: string; simulated: boolean }>()
  const [spaces, setSpaces] = useState<readonly Space[]>([])
  const [spaceId, setSpaceId] = useState<string>()
  const [materials, setMaterials] = useState<readonly MaterialSummary[]>([])
  const [sessions, setSessions] = useState<readonly Session[]>([])
  const [threadId, setThreadId] = useState<string>()
  const [turns, setTurns] = useState<readonly Turn[]>([])
  const [understanding, setUnderstanding] = useState<Understanding>(NO_UNDERSTANDING)
  const [source, setSource] = useState<SourceRequest>()
  const [tab, setTab] = useState<SideTab>('source')
  const [pane, setPane] = useState<Pane>('shelf')
  const [notice, setNotice] = useState<string>()
  const [asking, setAsking] = useState(false)
  const [failed, setFailed] = useState<{ question: string; failure: Failure }>()
  const [library, setLibrary] = useState<{
    workflows: readonly WorkflowInfo[]
    blocks: readonly BlockInfo[]
  }>({ workflows: [], blocks: [] })
  const [plans, setPlans] = useState<readonly Plan[]>([])
  const [planId, setPlanId] = useState<string>()
  const [planNotice, setPlanNotice] = useState<string>()
  const [learned, setLearned] = useState(0)
  const [selectedNode, setSelectedNode] = useState<string>()
  const [focusedTurn, setFocusedTurn] = useState<string>()

  const space = spaces.find((candidate) => candidate.id === spaceId)
  const planInView = plans.find((plan) => plan.id === planId)
  const threadInView = planId === undefined ? threadId : planInView?.thread

  useEffect(() => {
    if (focusedTurn === undefined) return undefined
    let tries = 0
    const looking = setInterval(() => {
      tries += 1
      const found = document.getElementById(`turn-${focusedTurn}`)
      if (found !== null) found.scrollIntoView?.({ block: 'center' })
      if (found !== null || tries >= FOCUS_TRIES) clearInterval(looking)
    }, 100)
    return () => clearInterval(looking)
  }, [focusedTurn])

  const guard = useCallback(
    (work: () => Promise<unknown>): void => {
      setNotice(undefined)
      work().catch((error: unknown) => {
        // On a shared service a session ends with the run: the person signs in again.
        if (me.mode === 'shared' && error instanceof ApiError && error.code === 'signed_out') {
          onSignIn()
          return
        }
        setNotice(messageOf(error))
      })
    },
    [me.mode, onSignIn],
  )

  const openThread = useCallback(async (thread: string | undefined) => {
    setThreadId(thread)
    setFailed(undefined)
    setTurns(thread === undefined ? [] : (await api.session(thread)).turns)
  }, [])

  useEffect(() => {
    guard(async () => {
      setModel(await api.model())
      setLibrary(await api.workflows())
      const listed = (await api.spaces()).spaces
      setSpaces(listed)
      const open = listed.filter((candidate) => !candidate.archived)
      const last = remembered()
      setSpaceId((open.find((candidate) => candidate.id === last) ?? open[0])?.id)
    })
  }, [guard])

  useEffect(() => {
    setSource(undefined)
    setSelectedNode(nodeAfterSwitch.current)
    nodeAfterSwitch.current = undefined
    setFocusedTurn(undefined)
    if (spaceId === undefined) {
      setMaterials([])
      setSessions([])
      setUnderstanding(NO_UNDERSTANDING)
      setPlans([])
      setPlanId(undefined)
      void openThread(undefined)
      return
    }
    remember(spaceId)
    guard(async () => {
      const [listed, threads, held, planned] = await Promise.all([
        api.materials(spaceId),
        api.sessions(spaceId),
        api.understanding(spaceId),
        api.plans(spaceId),
      ])
      setMaterials(listed.materials)
      setSessions(threads.sessions)
      setUnderstanding(held)
      setPlans(planned.plans)
      setPlanNotice(undefined)
      // Coming back to a space picks up where the person left off, in a plan or a conversation.
      const ownThreads = new Set(planned.plans.map((plan) => plan.thread))
      const latest = threads.sessions
        .filter((session) => !ownThreads.has(session.id))
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      const unfinished = planned.plans
        .filter((plan) => plan.status !== 'done')
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const resume =
        unfinished !== undefined && unfinished.updatedAt >= (latest?.createdAt ?? 0)
          ? unfinished
          : undefined
      setPlanId(resume?.id)
      await openThread(resume === undefined ? latest?.id : undefined)
    })
  }, [spaceId, guard, openThread])

  // A host agent writes while this page sits in the background, so coming back to it reads again.
  useEffect(() => {
    const reread = (): void => {
      void (async () => {
        const listed = (await api.spaces()).spaces
        setSpaces(listed)
        setSpaceId((held) => held ?? listed.find((candidate) => !candidate.archived)?.id)
        if (spaceId === undefined) return
        const [planned, held] = await Promise.all([api.plans(spaceId), api.understanding(spaceId)])
        setPlans(planned.plans)
        setUnderstanding(held)
        setLearned((count) => count + 1)
      })().catch(() => undefined)
    }
    window.addEventListener('focus', reread)
    return () => window.removeEventListener('focus', reread)
  }, [spaceId])

  const refreshMaterials = async (): Promise<void> => {
    if (spaceId !== undefined) setMaterials((await api.materials(spaceId)).materials)
  }

  const refreshUnderstanding = async (): Promise<void> => {
    if (spaceId !== undefined) setUnderstanding(await api.understanding(spaceId))
  }

  const ask = (question: string, retry: boolean): void => {
    if (spaceId === undefined) return
    setAsking(true)
    setFailed(undefined)
    setFocusedTurn(undefined)
    if (!retry) {
      setTurns((held) => [...held, { id: 'asking', speaker: 'learner', text: question }])
    }
    guard(async () => {
      try {
        const asked = await api.ask(spaceId, question, threadId, retry)
        setThreadId(asked.thread)
        setTurns((await api.session(asked.thread)).turns)
        setSessions((await api.sessions(spaceId)).sessions)
        if (asked.failure !== undefined) setFailed({ question, failure: asked.failure })
      } finally {
        setAsking(false)
      }
    })
  }

  const showSource = (request: SourceRequest): void => {
    setSource(request)
    setTab('source')
    setPane('side')
  }

  const cite = (citation: Citation, evidence?: Evidence): void => {
    showSource({
      materialId: citation.materialId,
      title: citation.title,
      citation,
      ...(evidence === undefined ? {} : { evidence }),
    })
  }

  const makeCandidates = async (
    thread: string | undefined,
    reply: string,
  ): Promise<string | undefined> => {
    if (spaceId === undefined || thread === undefined) return undefined
    const made = await api.candidates(spaceId, thread, reply)
    await refreshUnderstanding()
    if (made.suggestions.length > 0) {
      setTab('pending')
      setPane('side')
    }
    return made.message
  }

  const offerTurn = async (thread: string, turn: string): Promise<string | undefined> => {
    if (spaceId === undefined) return undefined
    const made = await api.candidatesFromTurn(spaceId, thread, turn)
    await refreshUnderstanding()
    if (made.suggestions.length > 0) {
      setTab('pending')
      setPane('side')
    }
    return made.message
  }

  const openNode = (node: string): void => {
    setSelectedNode(node)
    setTab('understood')
    setPane('side')
  }

  const openPublication = (id: string): void => {
    setCommons(true)
    setPublication(id)
    setPane('talk')
  }

  const refreshNames = useCallback(async () => {
    onNames(await api.me())
  }, [onNames])

  const nameOf = (actor: string): string =>
    actor === me.actorId ? '你' : (me.names[actor] ?? '另一位用户')

  /** From an understanding back to the words it came from, in a conversation or a plan. */
  const jumpTo = (thread: string, turn: string | undefined): void => {
    const plan = plans.find((candidate) => candidate.thread === thread)
    setFocusedTurn(turn)
    setPane('talk')
    if (plan !== undefined && plan.origin !== 'host') {
      setPlanId(plan.id)
      return
    }
    setPlanId(undefined)
    guard(() => openThread(thread))
  }

  const decided = async (): Promise<void> => {
    await refreshUnderstanding()
    setLearned((held) => held + 1)
  }

  return (
    <Links.Provider
      value={{
        nodes: understanding.nodes,
        focused: focusedTurn,
        openNode,
        nameOf,
        refreshNames,
        openPublication,
        sharing: me.sharing,
        offer: offerTurn,
      }}
    >
      <div className="desk" data-pane={pane}>
        <Shelf
          spaces={spaces}
          current={spaceId}
          materials={materials}
          sessions={sessions.filter((session) => !plans.some((plan) => plan.thread === session.id))}
          thread={planId === undefined ? threadId : undefined}
          plans={
            <PlanShelf
              plans={plans}
              current={planId}
              workflows={library.workflows}
              hasMaterial={materials.length > 0}
              archived={space?.archived === true}
              guard={guard}
              onCreate={(topic, minutes, workflow) =>
                api.createPlan(spaceId ?? '', topic, minutes, workflow)
              }
              onCreated={(plan, created) => {
                setPlans((held) => [plan, ...held])
                setPlanNotice(created)
                setPlanId(plan.id)
                setPane('talk')
              }}
              onSelect={(id) => {
                setCommons(false)
                setPlanNotice(undefined)
                setPlanId(id)
                setPane('talk')
              }}
            />
          }
          guard={guard}
          identity={
            <Identity
              me={me}
              commons={commons}
              onCommons={() => {
                setCommons(true)
                setPublication(undefined)
                setPane('talk')
              }}
              onSignIn={onSignIn}
            />
          }
          onSpaces={(next, selected) => {
            setSpaces(next)
            if (selected !== undefined) setSpaceId(selected)
          }}
          onSelectSpace={(id) => {
            setSpaceId(id)
            setCommons(false)
            setPane('talk')
          }}
          onMaterialsChanged={refreshMaterials}
          onOpenMaterial={(material) =>
            showSource({ materialId: material.id, title: material.title })
          }
          onSelectThread={(id) => {
            setCommons(false)
            setPlanId(undefined)
            guard(() => openThread(id))
            setPane('talk')
          }}
          onNewThread={() => {
            setCommons(false)
            setPlanId(undefined)
            guard(() => openThread(undefined))
            setPane('talk')
          }}
        />
        <main className="talk">
          {model?.simulated === true && (
            <p className="banner">
              现在用的是模拟模型：它只摘录材料原句，不会真正回答。配置 EPISTEME_MODEL_BASE_URL
              后可接入真实模型。
            </p>
          )}
          {notice !== undefined && (
            <p className="banner banner-error" role="alert">
              {notice}
            </p>
          )}
          {commons ? (
            <Commons
              me={me.actorId}
              spaces={spaces}
              current={spaceId}
              dimensions={understanding.dimensions}
              opened={publication}
              onOpen={setPublication}
              onChanged={decided}
              onOpenNode={(space, node) => {
                if (space === spaceId) {
                  openNode(node)
                  return
                }
                nodeAfterSwitch.current = node
                setSpaceId(space)
                setTab('understood')
                setPane('side')
              }}
            />
          ) : planId === undefined ? (
            <Conversation
              space={space}
              hasMaterial={materials.length > 0}
              thread={threadId}
              turns={turns}
              asking={asking}
              failed={failed}
              onAsk={ask}
              onCite={cite}
              onCandidates={(reply) => makeCandidates(threadId, reply)}
            />
          ) : planInView?.origin === 'host' && spaceId !== undefined ? (
            <Outcomes
              space={spaceId}
              name={space?.name ?? ''}
              focus={planId}
              version={learned}
              blocks={library.blocks}
              onReview={() => {
                setTab('pending')
                setPane('side')
              }}
              onOpenThread={(thread) => jumpTo(thread, undefined)}
            />
          ) : (
            <PlanView
              plan={planId}
              blocks={library.blocks}
              workflows={library.workflows}
              notice={planNotice}
              guard={guard}
              onChanged={() => {
                setLearned((held) => held + 1)
                if (spaceId !== undefined) {
                  guard(async () => setPlans((await api.plans(spaceId)).plans))
                }
              }}
              onCite={cite}
              onCandidates={makeCandidates}
              onShowStatus={() => {
                setTab('status')
                setPane('side')
              }}
            />
          )}
        </main>
        <Side
          tab={tab}
          onTab={setTab}
          source={source}
          understanding={understanding}
          guard={guard}
          onDecided={decided}
          pending={
            <ExtractFromThread
              space={spaceId}
              thread={threadInView}
              onMade={refreshUnderstanding}
            />
          }
          understood={
            spaceId === undefined ? null : (
              <UnderstandingPanel
                space={spaceId}
                understanding={understanding}
                selected={selectedNode}
                simulated={model?.simulated === true}
                guard={guard}
                onSelect={setSelectedNode}
                onChanged={decided}
                onJump={jumpTo}
              />
            )
          }
          status={<StatusView space={spaceId} version={learned} />}
        />
        <nav className="switcher" aria-label="切换页面">
          <button type="button" aria-current={pane === 'shelf'} onClick={() => setPane('shelf')}>
            空间
          </button>
          <button type="button" aria-current={pane === 'talk'} onClick={() => setPane('talk')}>
            对话
          </button>
          <button type="button" aria-current={pane === 'side'} onClick={() => setPane('side')}>
            原文与理解
          </button>
        </nav>
      </div>
    </Links.Provider>
  )
}

/** Who is here, and the way to what people have published, when this service has either. */
function Identity(props: {
  me: Me
  commons: boolean
  onCommons: () => void
  onSignIn: () => void
}) {
  const { me } = props
  if (!me.sharing && me.mode !== 'shared') return null
  return (
    <section className="identity">
      {me.mode === 'shared' && (
        <p className="hint">
          现在是 {me.names[me.actorId] ?? '你'}。{' '}
          <button type="button" className="link" onClick={props.onSignIn}>
            换一个身份
          </button>
        </p>
      )}
      {me.sharing && (
        <button
          type="button"
          className="row"
          aria-current={props.commons}
          onClick={props.onCommons}
        >
          公开成果
        </button>
      )}
    </section>
  )
}

/** Asks a model what in this conversation is worth keeping. What comes back still waits for the person. */
function ExtractFromThread(props: {
  space: string | undefined
  thread: string | undefined
  onMade: () => Promise<void>
}) {
  const [working, setWorking] = useState(false)
  const [note, setNote] = useState<string>()
  const { space, thread } = props
  if (space === undefined || thread === undefined) return null
  return (
    <p className="extract">
      <button
        type="button"
        className="link"
        disabled={working}
        onClick={() => {
          setWorking(true)
          setNote(undefined)
          api
            .candidatesFromThread(space, thread)
            .then(async (made) => {
              if (made.failure !== undefined) setNote(`${made.failure.message}可以再试一次。`)
              else setNote(made.message)
              await props.onMade()
            })
            .catch((error: unknown) => setNote(messageOf(error)))
            .finally(() => setWorking(false))
        }}
      >
        {working ? '正在读这段对话…' : '从当前对话提炼'}
      </button>
      {note !== undefined && <span className="hint"> {note}</span>}
    </p>
  )
}

function Shelf(props: {
  spaces: readonly Space[]
  current: string | undefined
  materials: readonly MaterialSummary[]
  sessions: readonly Session[]
  thread: string | undefined
  plans: ReactNode
  guard: (work: () => Promise<unknown>) => void
  identity: ReactNode
  onSpaces: (spaces: readonly Space[], selected?: string) => void
  onSelectSpace: (id: string) => void
  onMaterialsChanged: () => Promise<void>
  onOpenMaterial: (material: MaterialSummary) => void
  onSelectThread: (id: string) => void
  onNewThread: () => void
}) {
  const { spaces, current, materials, sessions, guard } = props
  const [name, setName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState<string>()
  const [armedDelete, setArmedDelete] = useState<string>()
  const [renaming, setRenaming] = useState<string>()
  const replaceTarget = useRef<string | undefined>(undefined)
  const replaceInput = useRef<HTMLInputElement>(null)
  const open = spaces.filter((space) => !space.archived)
  const archived = spaces.filter((space) => space.archived)
  const currentSpace = spaces.find((space) => space.id === current)

  const reload = async (selected?: string): Promise<void> => {
    props.onSpaces((await api.spaces()).spaces, selected)
  }

  const create = (event: FormEvent): void => {
    event.preventDefault()
    const wanted = name.trim()
    if (wanted === '') return
    guard(async () => {
      const { space } = await api.createSpace(wanted)
      setName('')
      await reload(space.id)
      props.onSelectSpace(space.id)
    })
  }

  const upload = (files: FileList | null): void => {
    if (files === null || files.length === 0 || current === undefined) return
    const chosen = [...files]
    setUploading(true)
    setUploadNote(undefined)
    guard(async () => {
      try {
        for (const file of chosen) {
          const { duplicate } = await api.upload(current, file)
          if (duplicate) setUploadNote(`“${file.name}”的内容已经在这个空间里了。`)
        }
      } finally {
        setUploading(false)
        await props.onMaterialsChanged()
      }
    })
  }

  return (
    <aside className="shelf" aria-label="空间">
      <h1 className="wordmark">学习工作台</h1>
      {props.identity}
      <section>
        <h2>空间</h2>
        <ul className="list">
          {open.map((space) => (
            <li key={space.id}>
              {renaming === space.id ? (
                <form
                  className="inline-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const value = new FormData(event.currentTarget).get('name')
                    guard(async () => {
                      await api.updateSpace(space.id, {
                        name: typeof value === 'string' ? value : '',
                      })
                      setRenaming(undefined)
                      await reload()
                    })
                  }}
                >
                  <input name="name" aria-label="新名字" defaultValue={space.name} />
                  <button type="submit">保存</button>
                </form>
              ) : (
                <button
                  type="button"
                  className="row"
                  aria-current={space.id === current}
                  onClick={() => props.onSelectSpace(space.id)}
                >
                  {space.name}
                </button>
              )}
            </li>
          ))}
        </ul>
        {open.length === 0 && <p className="hint">给要学的东西建一个空间，比如“线性代数”。</p>}
        <form className="inline-form" onSubmit={create}>
          <input
            aria-label="新空间的名字"
            placeholder="新空间的名字"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit">新建</button>
        </form>
        {currentSpace !== undefined && !currentSpace.archived && (
          <p className="quiet-actions">
            <button type="button" className="link" onClick={() => setRenaming(currentSpace.id)}>
              改名
            </button>
            <button
              type="button"
              className="link"
              onClick={() =>
                guard(async () => {
                  await api.updateSpace(currentSpace.id, { archived: true })
                  const others = open.filter((space) => space.id !== currentSpace.id)
                  await reload(others[0]?.id)
                })
              }
            >
              归档这个空间
            </button>
          </p>
        )}
        {archived.length > 0 && (
          <details className="archived">
            <summary>已归档（{archived.length}）</summary>
            <ul className="list">
              {archived.map((space) => (
                <li key={space.id} className="row-with-action">
                  <span>{space.name}</span>
                  <button
                    type="button"
                    className="link"
                    aria-label={`恢复 ${space.name}`}
                    onClick={() =>
                      guard(async () => {
                        await api.updateSpace(space.id, { archived: false })
                        await reload(space.id)
                      })
                    }
                  >
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {currentSpace !== undefined && (
        <>
          <section>
            <h2>材料</h2>
            <ul className="list">
              {materials.map((material) => (
                <li key={material.id} className="material">
                  <button
                    type="button"
                    className="row"
                    onClick={() => props.onOpenMaterial(material)}
                  >
                    {material.title}
                  </button>
                  <span className="quiet-actions">
                    <button
                      type="button"
                      className="link"
                      aria-label={`更新 ${material.title}`}
                      onClick={() => {
                        replaceTarget.current = material.id
                        replaceInput.current?.click()
                      }}
                    >
                      更新
                    </button>
                    <button
                      type="button"
                      className="link link-danger"
                      aria-label={`删除 ${material.title}`}
                      onClick={() => {
                        if (armedDelete !== material.id) {
                          setArmedDelete(material.id)
                          return
                        }
                        setArmedDelete(undefined)
                        guard(async () => {
                          await api.deleteMaterial(material.id)
                          await props.onMaterialsChanged()
                        })
                      }}
                    >
                      {armedDelete === material.id ? '再点一次确认删除' : '删除'}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <label className="upload" aria-disabled={uploading}>
              {uploading ? '正在读取…' : '上传材料'}
              <input
                type="file"
                multiple
                accept=".txt,.md,.markdown,.pdf"
                disabled={uploading || currentSpace.archived}
                onChange={(event) => {
                  upload(event.target.files)
                  event.target.value = ''
                }}
              />
            </label>
            <p className="hint">支持 TXT、Markdown 和有文字层的 PDF，单个不超过 20 MB。</p>
            {uploadNote !== undefined && <p className="hint">{uploadNote}</p>}
            <input
              ref={replaceInput}
              className="hidden-input"
              type="file"
              aria-label="选择新版本文件"
              accept=".txt,.md,.markdown,.pdf"
              onChange={(event) => {
                const file = event.target.files?.[0]
                const id = replaceTarget.current
                event.target.value = ''
                if (file === undefined || id === undefined) return
                guard(async () => {
                  await api.replace(id, file)
                  await props.onMaterialsChanged()
                })
              }}
            />
          </section>
          {props.plans}
          <section>
            <h2>对话</h2>
            <ul className="list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className="row"
                    aria-current={session.id === props.thread}
                    onClick={() => props.onSelectThread(session.id)}
                  >
                    {session.title}
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="link" onClick={props.onNewThread}>
              开始新对话
            </button>
          </section>
        </>
      )}
    </aside>
  )
}

function Conversation(props: {
  space: Space | undefined
  hasMaterial: boolean
  thread: string | undefined
  turns: readonly Turn[]
  asking: boolean
  failed: { question: string; failure: Failure } | undefined
  onAsk: (question: string, retry: boolean) => void
  onCite: (citation: Citation, evidence?: Evidence) => void
  onCandidates: (reply: string) => Promise<string | undefined>
}) {
  const { space, turns, asking, failed } = props
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [turns.length, asking, failed])

  if (space === undefined) {
    return (
      <div className="empty">
        <p>先在左边新建一个空间，把要学的东西放进来。</p>
      </div>
    )
  }

  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    const question = draft.trim()
    if (question === '' || asking) return
    setDraft('')
    props.onAsk(question, false)
  }

  return (
    <>
      <div className="page">
        <h2 className="space-title">{space.name}</h2>
        {turns.length === 0 && (
          <p className="hint page-hint">
            {props.hasMaterial
              ? '就材料提一个问题。回答里的每句话都会标明它从哪来。'
              : '先上传一份材料，再就它提问。'}
          </p>
        )}
        {turns.map((turn) =>
          turn.speaker === 'learner' ? (
            <LearnerTurn key={turn.id} turn={turn} thread={props.thread} />
          ) : (
            <AgentTurn
              key={turn.id}
              turn={turn}
              onCite={props.onCite}
              onCandidates={props.onCandidates}
            />
          ),
        )}
        {asking && (
          <p className="working" role="status">
            正在查材料并回答…
          </p>
        )}
        {failed !== undefined && (
          <div className="failed" role="alert">
            <p>{failed.failure.message}你的问题已保留。</p>
            {failed.failure.retryable && (
              <button type="button" onClick={() => props.onAsk(failed.question, true)}>
                重试
              </button>
            )}
          </div>
        )}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea
          aria-label="你的问题"
          placeholder={space.archived ? '这个空间已归档' : '问一个关于材料的问题'}
          rows={2}
          value={draft}
          disabled={space.archived}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button type="submit" disabled={asking || draft.trim() === '' || space.archived}>
          提问
        </button>
      </form>
    </>
  )
}

function Side(props: {
  tab: SideTab
  onTab: (tab: SideTab) => void
  source: SourceRequest | undefined
  understanding: Understanding
  guard: (work: () => Promise<unknown>) => void
  onDecided: () => Promise<void>
  pending: ReactNode
  understood: ReactNode
  status: ReactNode
}) {
  const { tab, understanding } = props
  const tabs: readonly (readonly [SideTab, string])[] = [
    ['source', '原文'],
    ['pending', `待确认（${understanding.pending.length}）`],
    [
      'understood',
      `我的理解（${understanding.nodes.filter((node) => node.revisedTo === undefined && !node.withdrawn).length}）`,
    ],
    ['status', '学习状态'],
  ]
  return (
    <aside className="side" aria-label="原文与理解">
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            type="button"
            role="tab"
            key={id}
            aria-selected={tab === id}
            onClick={() => props.onTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="side-body">
        {tab === 'source' && <SourceView request={props.source} />}
        {tab === 'status' && props.status}
        {tab === 'pending' && (
          <>
            {props.pending}
            <PendingList
              pending={understanding.pending}
              guard={props.guard}
              onDecided={props.onDecided}
            />
          </>
        )}
        {tab === 'understood' && props.understood}
      </div>
    </aside>
  )
}

function SourceView({ request }: { request: SourceRequest | undefined }) {
  const [material, setMaterial] = useState<MaterialText>()
  const [missing, setMissing] = useState(false)
  const mark = useRef<HTMLElement>(null)

  useEffect(() => {
    setMaterial(undefined)
    setMissing(false)
    if (request === undefined) return undefined
    let current = true
    api
      .material(request.materialId)
      .then((reply) => {
        if (current) setMaterial(reply.material)
      })
      .catch(() => {
        if (current) setMissing(true)
      })
    return () => {
      current = false
    }
  }, [request])

  useEffect(() => {
    mark.current?.scrollIntoView?.({ block: 'center' })
  }, [material])

  if (request === undefined) {
    return <p className="hint">点回答里的角标，或左边的材料名，原文会在这里打开。</p>
  }
  const { citation } = request
  const marked = request.evidence ?? citation
  const where =
    citation === undefined
      ? undefined
      : [
          citation.page === undefined ? `第 ${citation.line} 行` : `第 ${citation.page} 页`,
          citation.section,
        ]
          .filter((part) => part !== undefined)
          .join('，')
  const header = (
    <header className="source-head">
      <h3>{request.title}</h3>
      {where !== undefined && <p className="hint">{where}</p>}
    </header>
  )
  if (missing) {
    return (
      <>
        {header}
        <p className="hint">这份材料已被删除。下面是回答时引用的片段。</p>
        {citation !== undefined && <blockquote className="kept-quote">{citation.quote}</blockquote>}
      </>
    )
  }
  if (material === undefined) {
    return (
      <>
        {header}
        <p className="working" role="status">
          正在打开原文…
        </p>
      </>
    )
  }
  // A newer version has different offsets, so the passage is shown as it was cited rather than marked at the
  // wrong place.
  if (citation !== undefined && material.version !== citation.materialVersion) {
    return (
      <>
        {header}
        <p className="hint">材料在回答之后更新过。回答引用的是旧版本里的这段话：</p>
        <blockquote className="kept-quote">{citation.quote}</blockquote>
        <pre className="source-text">{material.text}</pre>
      </>
    )
  }
  return (
    <>
      {header}
      <pre className="source-text">
        {marked === undefined ? (
          material.text
        ) : (
          <>
            {material.text.slice(0, marked.start)}
            <mark ref={mark}>{material.text.slice(marked.start, marked.end)}</mark>
            {material.text.slice(marked.end)}
          </>
        )}
      </pre>
    </>
  )
}

function PendingList(props: {
  pending: readonly PendingCandidate[]
  guard: (work: () => Promise<unknown>) => void
  onDecided: () => Promise<void>
}) {
  if (props.pending.length === 0) {
    return (
      <p className="hint">
        没有待确认的内容。可以点你说过的话旁边的“这是我的理解”，或回答下面的“提炼成待确认的理解”。
      </p>
    )
  }
  return (
    <ul className="pending">
      {props.pending.map((candidate) => (
        <PendingItem
          key={candidate.id}
          candidate={candidate}
          guard={props.guard}
          onDecided={props.onDecided}
        />
      ))}
    </ul>
  )
}

function PendingItem(props: {
  candidate: PendingCandidate
  guard: (work: () => Promise<unknown>) => void
  onDecided: () => Promise<void>
}) {
  const { candidate, guard, onDecided } = props
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(candidate.proposal.label ?? '')
  const { link } = candidate
  const decide = (work: () => Promise<unknown>): void => {
    guard(async () => {
      await work()
      await onDecided()
    })
  }
  if (link !== undefined) {
    const relation =
      candidate.proposal.relation === 'evolves_to'
        ? '修正为'
        : candidate.proposal.relation === 'contradicts'
          ? '和这一条矛盾：'
          : '支持这一条：'
    return (
      <li>
        <p className="candidate">{link.fromLabel}</p>
        <p className="candidate">
          <span className="hint">{relation}</span> {link.toLabel}
        </p>
        <p className="hint">{candidate.rationale}</p>
        {!link.ready && <p className="hint">先确认它连着的两条，才能确认这个关系。</p>}
        <p className="decisions">
          <button
            type="button"
            disabled={!link.ready}
            onClick={() => decide(() => api.accept(candidate.id))}
          >
            确认这个关系
          </button>
          <button
            type="button"
            className="link"
            onClick={() => decide(() => api.dismiss(candidate.id))}
          >
            不要
          </button>
        </p>
      </li>
    )
  }
  return (
    <li>
      {editing ? (
        <textarea
          aria-label="修改这条理解"
          rows={3}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      ) : (
        <p className="candidate">{candidate.proposal.label}</p>
      )}
      <p className="hint">
        {wordsOf(candidate.basis, candidate.wordsBy)}。{candidate.rationale}
      </p>
      {candidate.similar !== undefined && <p className="hint">和这一条相近：{candidate.similar}</p>}
      <p className="decisions">
        {editing ? (
          <button
            type="button"
            disabled={label.trim() === ''}
            onClick={() => decide(() => api.acceptEdited(candidate, label.trim()))}
          >
            保存为我的理解
          </button>
        ) : (
          <>
            <button type="button" onClick={() => decide(() => api.accept(candidate.id))}>
              确认为我的理解
            </button>
            <button type="button" className="link" onClick={() => setEditing(true)}>
              改一改
            </button>
          </>
        )}
        <button
          type="button"
          className="link"
          onClick={() => decide(() => api.dismiss(candidate.id))}
        >
          不要
        </button>
      </p>
    </li>
  )
}
