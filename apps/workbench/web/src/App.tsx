import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useLocation, useSearch } from 'wouter'
import { useHistoryState } from 'wouter/use-browser-location'
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
import { PlanShelf, PlanView } from './Learning.js'
import { Outcomes } from './Outcomes.js'
import {
  hrefOf,
  opensSide,
  panelOf,
  usePlace,
  type Panel,
  type Place,
  type SideTab,
} from './routes.js'
import { AgentTurn, LearnerTurn, Links, messageOf } from './Turns.js'
import { UnderstandingPanel, wordsOf } from './Understanding.js'

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

/** The passage a citation points at, kept in its history entry so a refresh or going back marks it again. */
interface Cited {
  readonly materialId: string
  readonly citation: Citation
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
  const place = usePlace()
  const [, navigate] = useLocation()
  // Read for the re-render when only the query changes; the router's copy has already decoded the values.
  useSearch()
  const panel = panelOf(window.location.search)
  const cited = useHistoryState<Cited | null>()
  /** The latest address, for work that finishes after the person may have moved on. */
  const here = useRef({ place, panel, cited })
  here.current = { place, panel, cited }

  const go = useCallback(
    (
      to: Place,
      next: Panel = {},
      options: { readonly replace?: boolean; readonly cited?: Cited } = {},
    ): void => {
      const href = hrefOf(to, next)
      const from = here.current
      navigate(href, {
        // The same address twice would make the back button seem to do nothing.
        replace: options.replace === true || href === hrefOf(from.place, from.panel),
        state:
          options.cited ?? (next.material === from.panel.material ? (from.cited ?? null) : null),
      })
    },
    [navigate],
  )

  /** Changes what the side column shows and leaves the place open as it is. */
  const showPanel = useCallback(
    (next: Panel, options: { readonly cited?: Cited } = {}): void => {
      go(here.current.place, next, options)
    },
    [go],
  )

  /** The space on show. Public results have no space of their own, so the last one stays beside them. */
  const [heldSpace, setHeldSpace] = useState<string | undefined>(remembered() ?? undefined)
  const spaceId = 'space' in place ? place.space : heldSpace
  const threadId = place.kind === 'thread' ? place.thread : undefined
  const planId = place.kind === 'plan' ? place.plan : undefined
  const commons = place.kind === 'commons'
  const publication = place.kind === 'commons' ? place.publication : undefined
  const tab: SideTab = panel.side ?? 'source'
  const selectedNode = panel.node
  const focusedTurn = panel.turn

  const [model, setModel] = useState<{ name: string; simulated: boolean }>()
  const [spaces, setSpaces] = useState<readonly Space[]>([])
  const [listed, setListed] = useState(false)
  /** The space whose materials, conversations and plans are in hand. */
  const [loadedFor, setLoadedFor] = useState<string>()
  const [materials, setMaterials] = useState<readonly MaterialSummary[]>([])
  const [sessions, setSessions] = useState<readonly Session[]>([])
  const [turns, setTurns] = useState<readonly Turn[]>([])
  /** A conversation whose turns are already in hand because asking just started it. */
  const threadInHand = useRef<string | undefined>(undefined)
  const [understanding, setUnderstanding] = useState<Understanding>(NO_UNDERSTANDING)
  const [pane, setPane] = useState<Pane>(() =>
    opensSide(panel) ? 'side' : place.kind === 'home' ? 'shelf' : 'talk',
  )
  const [notice, setNotice] = useState<string>()
  const [asking, setAsking] = useState(false)
  const [failed, setFailed] = useState<{ question: string; failure: Failure }>()
  const [library, setLibrary] = useState<{
    workflows: readonly WorkflowInfo[]
    blocks: readonly BlockInfo[]
  }>({ workflows: [], blocks: [] })
  const [plans, setPlans] = useState<readonly Plan[]>([])
  const [planNotice, setPlanNotice] = useState<string>()
  const [learned, setLearned] = useState(0)

  const space = spaces.find((candidate) => candidate.id === spaceId)
  const spaceKnown = space !== undefined
  const planInView = plans.find((plan) => plan.id === planId)
  const threadInView = planId === undefined ? threadId : planInView?.thread
  const planLoaded = loadedFor === spaceId
  /** An address can name a space that is gone, or one this person cannot see. */
  const lostSpace = listed && 'space' in place && !spaceKnown

  const source = useMemo<SourceRequest | undefined>(() => {
    const { material } = panel
    if (material === undefined) return undefined
    const passage = cited?.materialId === material ? cited : undefined
    return {
      materialId: material,
      title:
        passage?.citation.title ??
        materials.find((candidate) => candidate.id === material)?.title ??
        '',
      ...(passage === undefined ? {} : { citation: passage.citation }),
      ...(passage?.evidence === undefined ? {} : { evidence: passage.evidence }),
    }
  }, [panel.material, cited, materials])

  // Going back or forward lands a phone on the column that changed.
  useEffect(() => {
    const opened = window.location.search
    const moved = (): void => {
      const now = window.location.search
      setPane(now !== opened && opensSide(panelOf(now)) ? 'side' : 'talk')
    }
    window.addEventListener('popstate', moved)
    return () => window.removeEventListener('popstate', moved)
  }, [panel.side, panel.node, panel.material, panel.turn])

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

  useEffect(() => {
    guard(async () => {
      setModel(await api.model())
      setLibrary(await api.workflows())
      setSpaces((await api.spaces()).spaces)
      setListed(true)
    })
  }, [guard])

  // An address without a space falls back on the last one still open, or the first.
  const addressedSpace = 'space' in place ? place.space : undefined
  const needsSpace = place.kind === 'home' || place.kind === 'commons'
  useEffect(() => {
    if (addressedSpace !== undefined) {
      setHeldSpace(addressedSpace)
      return
    }
    if (!listed || !needsSpace) return
    const open = spaces.filter((candidate) => !candidate.archived)
    const last = remembered()
    const fallback = (open.find((candidate) => candidate.id === last) ?? open[0])?.id
    setHeldSpace(fallback)
    if (place.kind === 'home' && fallback !== undefined) {
      go({ kind: 'space', space: fallback }, here.current.panel, { replace: true })
      if (!opensSide(here.current.panel)) setPane('talk')
    }
  }, [addressedSpace, listed, needsSpace, spaces, place.kind, go])

  // Public results may be switched off on this service, whatever an old link says.
  useEffect(() => {
    if (place.kind === 'commons' && !me.sharing) go({ kind: 'home' }, {}, { replace: true })
  }, [place.kind, me.sharing, go])

  const readable = spaceId !== undefined && spaceKnown
  useEffect(() => {
    setLoadedFor(undefined)
    if (!readable) {
      setMaterials([])
      setSessions([])
      setUnderstanding(NO_UNDERSTANDING)
      setPlans([])
      return undefined
    }
    remember(spaceId)
    let current = true
    guard(async () => {
      const [found, threads, held, planned] = await Promise.all([
        api.materials(spaceId),
        api.sessions(spaceId),
        api.understanding(spaceId),
        api.plans(spaceId),
      ])
      if (!current) return
      setMaterials(found.materials)
      setSessions(threads.sessions)
      setUnderstanding(held)
      setPlans(planned.plans)
      setPlanNotice(undefined)
      setLoadedFor(spaceId)
    })
    return () => {
      current = false
    }
  }, [spaceId, readable, guard])

  /** Where the person left off in this space, in a plan or a conversation. */
  const resume = useMemo<{ readonly label: string; readonly to: Place } | undefined>(() => {
    if (spaceId === undefined) return undefined
    const ownThreads = new Set(plans.map((plan) => plan.thread))
    const latest = [...sessions]
      .filter((session) => !ownThreads.has(session.id))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    const unfinished = [...plans]
      .filter((plan) => plan.status !== 'done')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (unfinished !== undefined && unfinished.updatedAt >= (latest?.createdAt ?? 0)) {
      return {
        label: unfinished.topic,
        to: { kind: 'plan', space: spaceId, plan: unfinished.id },
      }
    }
    return latest === undefined
      ? undefined
      : { label: latest.title, to: { kind: 'thread', space: spaceId, thread: latest.id } }
  }, [spaceId, plans, sessions])

  // A space with nothing in it has nothing to look back on, so it opens ready for the first question.
  const emptySpace =
    place.kind === 'space' &&
    loadedFor === place.space &&
    sessions.length === 0 &&
    plans.length === 0 &&
    understanding.pending.length === 0 &&
    understanding.nodes.length === 0
  const emptyId = emptySpace ? place.space : undefined
  useEffect(() => {
    if (emptyId !== undefined) {
      go({ kind: 'new', space: emptyId }, here.current.panel, { replace: true })
    }
  }, [emptyId, go])

  useEffect(() => {
    if (threadId !== undefined && threadInHand.current === threadId) {
      threadInHand.current = undefined
      return undefined
    }
    setFailed(undefined)
    if (threadId === undefined) {
      setTurns([])
      return undefined
    }
    let current = true
    guard(async () => {
      const found = await api.session(threadId)
      if (current) setTurns(found.turns)
    })
    return () => {
      current = false
    }
  }, [threadId, guard])

  // A host agent writes while this page sits in the background, so coming back to it reads again.
  useEffect(() => {
    const reread = (): void => {
      void (async () => {
        setSpaces((await api.spaces()).spaces)
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
    if (panel.turn !== undefined) {
      const { turn: _dropped, ...rest } = panel
      go(place, rest, { replace: true })
    }
    if (!retry) {
      setTurns((held) => [...held, { id: 'asking', speaker: 'learner', text: question }])
    }
    guard(async () => {
      try {
        const asked = await api.ask(spaceId, question, threadId, retry)
        setTurns((await api.session(asked.thread)).turns)
        setSessions((await api.sessions(spaceId)).sessions)
        if (asked.thread !== threadId) {
          threadInHand.current = asked.thread
          // A new conversation takes the empty one's place, so going back skips it.
          go({ kind: 'thread', space: spaceId, thread: asked.thread }, here.current.panel, {
            replace: true,
          })
        }
        if (asked.failure !== undefined) setFailed({ question, failure: asked.failure })
      } finally {
        setAsking(false)
      }
    })
  }

  /** Opens a side tab over whatever the side column was showing. */
  const showTab = useCallback(
    (side: SideTab): void => {
      showPanel({ ...here.current.panel, side })
      setPane('side')
    },
    [showPanel],
  )

  const cite = (citation: Citation, evidence?: Evidence): void => {
    showPanel(
      { ...panel, side: 'source', material: citation.materialId },
      {
        cited: {
          materialId: citation.materialId,
          citation,
          ...(evidence === undefined ? {} : { evidence }),
        },
      },
    )
    setPane('side')
  }

  const makeCandidates = async (
    thread: string | undefined,
    reply: string,
  ): Promise<string | undefined> => {
    if (spaceId === undefined || thread === undefined) return undefined
    const made = await api.candidates(spaceId, thread, reply)
    await refreshUnderstanding()
    if (made.suggestions.length > 0) showTab('pending')
    return made.message
  }

  const offerTurn = async (thread: string, turn: string): Promise<string | undefined> => {
    if (spaceId === undefined) return undefined
    const made = await api.candidatesFromTurn(spaceId, thread, turn)
    await refreshUnderstanding()
    if (made.suggestions.length > 0) showTab('pending')
    return made.message
  }

  const openNode = (node: string): void => {
    showPanel({ ...panel, side: 'understood', node })
    setPane('side')
  }

  const openPublication = (id: string): void => {
    go({ kind: 'commons', publication: id }, panel)
    setPane('talk')
  }

  /** Moves to another place in a space, leaving the side column as it is. */
  const moveTo = (to: Place): void => {
    const { turn: _dropped, ...rest } = panel
    go(to, rest)
    setPane('talk')
  }

  const refreshNames = useCallback(async () => {
    onNames(await api.me())
  }, [onNames])

  const nameOf = (actor: string): string =>
    actor === me.actorId ? '你' : (me.names[actor] ?? '另一位用户')

  /** From an understanding back to the words it came from, in a conversation or a plan. */
  const jumpTo = (thread: string, turn: string | undefined): void => {
    if (spaceId === undefined) return
    const plan = plans.find((candidate) => candidate.thread === thread)
    const { turn: _dropped, ...rest } = panel
    go(
      plan !== undefined && plan.origin !== 'host'
        ? { kind: 'plan', space: spaceId, plan: plan.id }
        : { kind: 'thread', space: spaceId, thread },
      turn === undefined ? rest : { ...rest, turn },
    )
    setPane('talk')
  }

  const decided = async (): Promise<void> => {
    await refreshUnderstanding()
    setLearned((held) => held + 1)
  }

  /** Enters a space where the person left off, on the side tab they were reading. */
  const enterSpace = (id: string): void => {
    go({ kind: 'space', space: id }, panel.side === undefined ? {} : { side: panel.side })
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
                if (spaceId !== undefined) moveTo({ kind: 'plan', space: spaceId, plan: plan.id })
              }}
              onSelect={(id) => {
                setPlanNotice(undefined)
                if (spaceId !== undefined) moveTo({ kind: 'plan', space: spaceId, plan: id })
              }}
            />
          }
          guard={guard}
          identity={
            <Identity
              me={me}
              commons={commons}
              onCommons={() => moveTo({ kind: 'commons' })}
              onSignIn={onSignIn}
            />
          }
          onSpaces={(next, selected) => {
            setSpaces(next)
            if (selected !== undefined) enterSpace(selected)
          }}
          onSelectSpace={(id) => {
            enterSpace(id)
            setPane('talk')
          }}
          onMaterialsChanged={refreshMaterials}
          onOpenMaterial={(material) => {
            showPanel({ ...panel, side: 'source', material: material.id })
            setPane('side')
          }}
          onSelectThread={(id) => {
            if (spaceId !== undefined) moveTo({ kind: 'thread', space: spaceId, thread: id })
          }}
          onNewThread={() => {
            if (spaceId !== undefined) moveTo({ kind: 'new', space: spaceId })
          }}
        />
        <main className="talk">
          {lostSpace && (
            <p className="banner banner-error" role="alert">
              找不到这个地址里的空间，它可能已被删除，或者你没有权限查看。可以从左边选一个空间。
            </p>
          )}
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
              onOpen={(id) =>
                go(
                  id === undefined ? { kind: 'commons' } : { kind: 'commons', publication: id },
                  panel,
                )
              }
              onChanged={decided}
              onOpenNode={(space, node) => {
                if (space === spaceId) {
                  openNode(node)
                  return
                }
                go({ kind: 'space', space }, { side: 'understood', node })
                setPane('side')
              }}
            />
          ) : lostSpace ? null : place.kind === 'space' ? (
            planLoaded ? (
              <Outcomes
                space={place.space}
                name={space?.name ?? ''}
                focus={undefined}
                version={learned}
                blocks={library.blocks}
                pending={understanding.pending}
                resume={
                  resume === undefined
                    ? undefined
                    : { label: resume.label, open: () => moveTo(resume.to) }
                }
                onNewThread={() => moveTo({ kind: 'new', space: place.space })}
                onReview={() => showTab('pending')}
                onOpenThread={(thread) => jumpTo(thread, undefined)}
              />
            ) : (
              <p className="working" role="status">
                正在打开…
              </p>
            )
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
              pending={understanding.pending}
              resume={undefined}
              onNewThread={() => moveTo({ kind: 'new', space: spaceId })}
              onReview={() => showTab('pending')}
              onOpenThread={(thread) => jumpTo(thread, undefined)}
            />
          ) : !planLoaded ? (
            // Which view a plan gets depends on who made it, and that is not known until the plans arrive.
            <p className="working" role="status">
              正在打开…
            </p>
          ) : planInView === undefined ? (
            <p className="banner banner-error" role="alert">
              这个空间里没有这份学习计划。可以从左边选一份。
            </p>
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
              onShowOverview={() => {
                if (spaceId !== undefined) moveTo({ kind: 'space', space: spaceId })
              }}
            />
          )}
        </main>
        <Side
          tab={tab}
          onTab={(side) => showPanel({ ...panel, side })}
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
                onSelect={(node) => {
                  const { node: _dropped, ...rest } = panel
                  showPanel(node === undefined ? rest : { ...rest, node })
                }}
                onChanged={decided}
                onJump={jumpTo}
              />
            )
          }
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
}) {
  const { tab, understanding } = props
  const tabs: readonly (readonly [SideTab, string])[] = [
    ['source', '原文'],
    ['pending', `待确认（${understanding.pending.length}）`],
    [
      'understood',
      `我的理解（${understanding.nodes.filter((node) => node.revisedTo === undefined && !node.withdrawn).length}）`,
    ],
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
