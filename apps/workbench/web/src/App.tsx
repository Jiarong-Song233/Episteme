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
  type HeldNode,
  type MaterialSummary,
  type MaterialText,
  type Me,
  type ModelInfo,
  type PendingCandidate,
  type Plan,
  type Session,
  type Space,
  type Turn,
  type Understanding,
  type WorkflowInfo,
} from './api.js'
import { Commons, SignIn } from './Commons.js'
import { AgentSessionsPage } from './AgentSessions.js'
import { ConnectPage } from './Connect.js'
import { ConversationsPage } from './Conversations.js'
import { UnfiledPage } from './Unfiled.js'
import { ModelPage } from './Model.js'
import { Welcome } from './Welcome.js'
import { PlanShelf, PlanView } from './Learning.js'
import { MaterialsPage } from './Materials.js'
import { Outcomes } from './Outcomes.js'
import {
  hrefOf,
  olderPlace,
  opensSide,
  panelOf,
  sectionOf,
  usePlace,
  type Panel,
  type Place,
  type Section,
} from './routes.js'
import { AgentTurn, LearnerTurn, Links, messageOf } from './Turns.js'
import { UnderstandingPanel, wordsOf } from './Understanding.js'

type Pane = 'shelf' | 'talk' | 'side' | 'rail'

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

const RAIL = 'workbench.rail'

/** Whether the understanding layer was left open. It opens by default: it is the point of the page. */
function railWasOpen(): boolean {
  try {
    return localStorage.getItem(RAIL) !== 'closed'
  } catch {
    return true
  }
}

function keepRail(open: boolean): void {
  try {
    localStorage.setItem(RAIL, open ? 'open' : 'closed')
  } catch {
    // Only a convenience: it opens again next time.
    return
  }
}

/** Pages that are the understanding layer already, or that belong to no space, have no rail beside them. */
const WITHOUT_RAIL: ReadonlySet<Place['kind']> = new Set([
  'review',
  'understanding',
  'connect',
  'model',
  'conversations',
  'unfiled',
  'agent-sessions',
  'commons',
])

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

  // An installed window can open while the service is away; coming back to it tries again.
  const away = problem !== undefined
  useEffect(() => {
    if (!away) return undefined
    window.addEventListener('focus', enter)
    window.addEventListener('online', enter)
    return () => {
      window.removeEventListener('focus', enter)
      window.removeEventListener('online', enter)
    }
  }, [away, enter])

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
        {problem}{' '}
        <button type="button" className="link" onClick={enter}>
          重试
        </button>
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

  // An older link keeps review or understanding in its query: it opens on that page instead.
  const older = olderPlace(place, window.location.search)
  const olderHref = older === undefined ? undefined : hrefOf(older, panel)
  useEffect(() => {
    if (olderHref !== undefined) navigate(olderHref, { replace: true })
  }, [olderHref, navigate])

  /** The space on show. Public results have no space of their own, so the last one stays beside them. */
  const [heldSpace, setHeldSpace] = useState<string | undefined>(remembered() ?? undefined)
  const spaceId = 'space' in place ? place.space : heldSpace
  const threadId = place.kind === 'thread' ? place.thread : undefined
  const planId = place.kind === 'plan' ? place.plan : undefined
  const commons = place.kind === 'commons'
  const publication = place.kind === 'commons' ? place.publication : undefined
  const section = sectionOf(place)
  const selectedNode = place.kind === 'understanding' ? place.node : undefined
  const focusedTurn = panel.turn

  const [model, setModel] = useState<ModelInfo>()
  const [spaces, setSpaces] = useState<readonly Space[]>([])
  const [listed, setListed] = useState(false)
  /** How many candidates wait without a space, so the way to them shows before anyone looks. */
  const [unfiled, setUnfiled] = useState(0)
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
  const [railOpen, setRailOpen] = useState(railWasOpen)

  const space = spaces.find((candidate) => candidate.id === spaceId)
  const spaceKnown = space !== undefined
  const planInView = plans.find((plan) => plan.id === planId)
  const threadInView = planId === undefined ? threadId : planInView?.thread
  const planLoaded = loadedFor === spaceId
  /** An address can name a space that is gone, or one this person cannot see. */
  const lostSpace = listed && 'space' in place && !spaceKnown
  /** Nothing here yet: the first visit, on the home address. */
  const welcoming = listed && spaces.length === 0 && place.kind === 'home'

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
  }, [panel.material, panel.turn])

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
      setUnfiled((await api.unfiled()).pending.length)
      setListed(true)
    })
  }, [guard])

  // An address without a space falls back on the last one still open, or the first.
  const addressedSpace = 'space' in place ? place.space : undefined
  const needsSpace =
    place.kind === 'home' ||
    place.kind === 'commons' ||
    place.kind === 'connect' ||
    place.kind === 'model' ||
    place.kind === 'conversations' ||
    place.kind === 'unfiled' ||
    place.kind === 'agent-sessions'
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

  const cite = (citation: Citation, evidence?: Evidence): void => {
    showPanel(
      { ...panel, material: citation.materialId },
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
    // What it made waits on the review page; the person stays in the conversation.
    const made = await api.candidates(spaceId, thread, reply)
    await refreshUnderstanding()
    return made.message
  }

  const offerTurn = async (thread: string, turn: string): Promise<string | undefined> => {
    if (spaceId === undefined) return undefined
    const made = await api.candidatesFromTurn(spaceId, thread, turn)
    await refreshUnderstanding()
    return made.message
  }

  /** A new line of the conversation on show, opened at once. The original stays where it was. */
  const forkAt = async (turn: string): Promise<void> => {
    if (spaceId === undefined || threadId === undefined) return
    const { session } = await api.fork(spaceId, threadId, turn)
    setSessions((await api.sessions(spaceId)).sessions)
    moveTo({ kind: 'thread', space: spaceId, thread: session.id })
  }
  const canFork =
    spaceId !== undefined &&
    threadId !== undefined &&
    planId === undefined &&
    space?.archived === false &&
    !asking

  const openNode = (node: string): void => {
    if (spaceId !== undefined) moveTo({ kind: 'understanding', space: spaceId, node })
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

  /** Enters a space on its overview. A source from another space would not belong beside it. */
  const enterSpace = (id: string): void => {
    go({ kind: 'space', space: id }, {})
  }

  const showSection = (to: Section): void => {
    if (spaceId === undefined) return
    if (to === 'overview') moveTo({ kind: 'space', space: spaceId })
    if (to === 'materials') moveTo({ kind: 'materials', space: spaceId })
    if (to === 'review') moveTo({ kind: 'review', space: spaceId })
    if (to === 'understanding') moveTo({ kind: 'understanding', space: spaceId })
    if (to === 'learning') moveTo(resume?.to ?? { kind: 'new', space: spaceId })
  }

  const heldNodes = understanding.nodes.filter(
    (node) => node.revisedTo === undefined && !node.withdrawn,
  )
  const heldCount = heldNodes.length

  const railAllowed = spaceKnown && !welcoming && !WITHOUT_RAIL.has(place.kind)
  const right = opensSide(panel) ? 'source' : railAllowed && railOpen ? 'rail' : 'none'
  const toggleRail = (): void => {
    const next = !(right === 'rail')
    setRailOpen(next)
    keepRail(next)
    if (next && opensSide(panel)) {
      const { material: _closed, ...rest } = panel
      showPanel(rest)
    }
    setPane(next ? 'rail' : 'talk')
  }
  const crumbs = crumbsOf(place, {
    space: space?.name,
    thread: sessions.find((session) => session.id === threadId)?.title,
    plan: planInView?.topic,
  })

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
        fork: canFork ? forkAt : undefined,
      }}
    >
      <div
        className="desk"
        data-pane={pane}
        data-right={right}
        data-rail={railAllowed ? 'allowed' : undefined}
      >
        <Shelf
          spaces={spaces}
          current={spaceId}
          nav={
            <SpaceNav
              section={section}
              materials={materials.length}
              pending={understanding.pending.length}
              held={heldCount}
              onShow={showSection}
            />
          }
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
          connect={
            <>
              <button
                type="button"
                className="row"
                aria-current={place.kind === 'model' ? 'page' : undefined}
                onClick={() => {
                  moveTo({ kind: 'model' })
                  setPane('talk')
                }}
              >
                模型
                <span className="row-note">
                  {model?.simulated === false ? model.name : '未设置'}
                </span>
              </button>
              <button
                type="button"
                className="row"
                aria-current={place.kind === 'connect' ? 'page' : undefined}
                onClick={() => {
                  moveTo({ kind: 'connect' })
                  setPane('talk')
                }}
              >
                接入 Agent
              </button>
              <button
                type="button"
                className="row"
                aria-current={place.kind === 'conversations' ? 'page' : undefined}
                onClick={() => {
                  moveTo({ kind: 'conversations' })
                  setPane('talk')
                }}
              >
                所有对话
              </button>
              <button
                type="button"
                className="row"
                aria-current={place.kind === 'unfiled' ? 'page' : undefined}
                onClick={() => {
                  moveTo({ kind: 'unfiled' })
                  setPane('talk')
                }}
              >
                未分类待确认
                {unfiled > 0 && <span className="row-note">{unfiled} 条</span>}
              </button>
              <button
                type="button"
                className="row"
                aria-current={place.kind === 'agent-sessions' ? 'page' : undefined}
                onClick={() => {
                  moveTo({ kind: 'agent-sessions' })
                  setPane('talk')
                }}
              >
                Agent 会话记录
              </button>
            </>
          }
          onSpaces={(next, selected) => {
            setSpaces(next)
            if (selected !== undefined) enterSpace(selected)
          }}
          onSelectSpace={(id) => {
            enterSpace(id)
            setPane('talk')
          }}
          onSelectThread={(id) => {
            if (spaceId !== undefined) moveTo({ kind: 'thread', space: spaceId, thread: id })
          }}
          onNewThread={() => {
            if (spaceId !== undefined) moveTo({ kind: 'new', space: spaceId })
          }}
        />
        <main className="talk">
          <header className="topbar">
            <p className="crumbs">
              {crumbs.map((crumb, index) => (
                // The same words can stand twice, a space and a conversation named alike.
                // biome-ignore lint/suspicious/noArrayIndexKey: the crumbs are a fixed path, never reordered
                <span key={index}>{crumb}</span>
              ))}
            </p>
            {railAllowed && (
              <button
                type="button"
                className="tool"
                aria-pressed={right === 'rail'}
                aria-label={
                  understanding.pending.length > 0
                    ? `理解层，${understanding.pending.length} 条等你确认`
                    : '理解层'
                }
                data-waiting={understanding.pending.length > 0}
                onClick={toggleRail}
              >
                <LayerGlyph />
                理解层
                {understanding.pending.length > 0 && (
                  <span className="count" aria-hidden="true">
                    {understanding.pending.length}
                  </span>
                )}
              </button>
            )}
          </header>
          {lostSpace && (
            <p className="banner banner-error" role="alert">
              找不到这个地址里的空间，它可能已被删除，或者你没有权限查看。可以从左边选一个空间。
            </p>
          )}
          {model?.simulated === true && place.kind !== 'model' && !welcoming && (
            <p className="banner">
              现在用的是模拟模型：它只摘录材料原句，不会真正回答。可以{' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  moveTo({ kind: 'model' })
                  setPane('talk')
                }}
              >
                设置一个模型
              </button>
              ，或{' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  moveTo({ kind: 'connect' })
                  setPane('talk')
                }}
              >
                接入 Agent
              </button>{' '}
              让它来讲解。
            </p>
          )}
          {notice !== undefined && (
            <p className="banner banner-error" role="alert">
              {notice}
            </p>
          )}
          {place.kind === 'connect' ? (
            <ConnectPage me={me} />
          ) : place.kind === 'model' ? (
            <ModelPage me={me} model={model} onChanged={setModel} />
          ) : place.kind === 'conversations' ? (
            <ConversationsPage
              onOpen={(space, thread) => {
                moveTo({ kind: 'thread', space, thread })
                setPane('talk')
              }}
            />
          ) : place.kind === 'unfiled' ? (
            <UnfiledPage
              nameOf={nameOf}
              spaces={spaces}
              guard={guard}
              onChanged={setUnfiled}
              onDecided={decided}
            />
          ) : place.kind === 'agent-sessions' ? (
            <AgentSessionsPage
              agent={place.agent}
              session={place.session}
              onOpen={(agent, session) =>
                moveTo({
                  kind: 'agent-sessions',
                  ...(agent === undefined ? {} : { agent }),
                  ...(session === undefined ? {} : { session }),
                })
              }
            />
          ) : welcoming ? (
            <Welcome
              model={model}
              guard={guard}
              onModel={() => {
                moveTo({ kind: 'model' })
                setPane('talk')
              }}
              onConnect={() => {
                moveTo({ kind: 'connect' })
                setPane('talk')
              }}
              onCreated={(created) => {
                setSpaces((held) => [...held, created])
                enterSpace(created.id)
              }}
            />
          ) : commons ? (
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
                go({ kind: 'understanding', space, node }, {})
                setPane('talk')
              }}
            />
          ) : lostSpace ? null : place.kind === 'materials' ||
            place.kind === 'review' ||
            place.kind === 'understanding' ? (
            !planLoaded || space === undefined ? (
              <p className="working" role="status">
                正在打开…
              </p>
            ) : place.kind === 'materials' ? (
              <MaterialsPage
                space={space}
                materials={materials}
                open={panel.material}
                guard={guard}
                onChanged={refreshMaterials}
                onOpen={(material) => {
                  showPanel({ ...panel, material: material.id })
                  setPane('side')
                }}
              />
            ) : place.kind === 'review' ? (
              <div className="page review">
                <h2 className="space-title">待确认</h2>
                <p className="hint page-hint">
                  这些是从对话里提出来的理解。只有你确认的才会成为你的理解，Agent 不能替你确认。
                </p>
                <PendingList pending={understanding.pending} guard={guard} onDecided={decided} />
              </div>
            ) : (
              <div className="page understanding">
                <h2 className="space-title">我的理解</h2>
                <UnderstandingPanel
                  space={place.space}
                  understanding={understanding}
                  selected={selectedNode}
                  simulated={model?.simulated === true}
                  guard={guard}
                  onSelect={(node) =>
                    moveTo(
                      node === undefined
                        ? { kind: 'understanding', space: place.space }
                        : { kind: 'understanding', space: place.space, node },
                    )
                  }
                  onChanged={decided}
                  onJump={jumpTo}
                />
              </div>
            )
          ) : place.kind === 'space' ? (
            planLoaded ? (
              <Outcomes
                space={place.space}
                name={space?.name ?? ''}
                focus={undefined}
                version={learned}
                blocks={library.blocks}
                pending={understanding.pending}
                held={understanding.nodes}
                resume={
                  resume === undefined
                    ? undefined
                    : { label: resume.label, open: () => moveTo(resume.to) }
                }
                onNewThread={() => moveTo({ kind: 'new', space: place.space })}
                onReview={() => moveTo({ kind: 'review', space: place.space })}
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
              branchOf={branchOf(sessions, threadId)}
              onForkPoint={(parent) => jumpTo(parent.thread, parent.turn)}
              turns={turns}
              asking={asking}
              failed={failed}
              onAsk={ask}
              onCite={cite}
              onCandidates={(reply) => makeCandidates(threadId, reply)}
              onMaterials={() => {
                if (spaceId !== undefined) moveTo({ kind: 'materials', space: spaceId })
              }}
              extract={
                <ExtractFromThread
                  space={spaceId}
                  thread={threadId}
                  onMade={refreshUnderstanding}
                />
              }
            />
          ) : planInView?.origin === 'host' && spaceId !== undefined ? (
            <Outcomes
              space={spaceId}
              name={space?.name ?? ''}
              focus={planId}
              version={learned}
              blocks={library.blocks}
              pending={understanding.pending}
              held={understanding.nodes}
              resume={undefined}
              onNewThread={() => moveTo({ kind: 'new', space: spaceId })}
              onReview={() => moveTo({ kind: 'review', space: spaceId })}
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
              extract={
                <ExtractFromThread
                  space={spaceId}
                  thread={threadInView}
                  onMade={refreshUnderstanding}
                />
              }
            />
          )}
        </main>
        <Side
          source={source}
          onClose={() => {
            const { material: _dropped, ...rest } = panel
            showPanel(rest)
            setPane('talk')
          }}
        />
        {railAllowed && spaceId !== undefined && (
          <Rail
            pending={understanding.pending}
            held={heldNodes}
            guard={guard}
            onDecided={decided}
            onOpenNode={(node) => moveTo({ kind: 'understanding', space: spaceId, node })}
            onOpenAll={() => moveTo({ kind: 'understanding', space: spaceId })}
            onClose={() => {
              setRailOpen(false)
              keepRail(false)
              setPane('talk')
            }}
          />
        )}
        <nav className="switcher" aria-label="切换页面">
          <button type="button" aria-current={pane === 'shelf'} onClick={() => setPane('shelf')}>
            空间
          </button>
          <button type="button" aria-current={pane === 'talk'} onClick={() => setPane('talk')}>
            这一页
          </button>
          <button type="button" aria-current={pane === 'side'} onClick={() => setPane('side')}>
            原文
          </button>
          {railAllowed && (
            <button type="button" aria-current={pane === 'rail'} onClick={() => setPane('rail')}>
              理解层
            </button>
          )}
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

/** The pages of the open space. The counts say what waits and what is held, before anyone opens them. */
function SpaceNav(props: {
  section: Section | undefined
  materials: number
  pending: number
  held: number
  onShow: (section: Section) => void
}) {
  const entries: readonly (readonly [Section, string, number | undefined])[] = [
    ['overview', '概览', undefined],
    ['learning', '学习', undefined],
    ['materials', '材料', props.materials],
    ['review', '待确认', props.pending],
    ['understanding', '我的理解', props.held],
  ]
  return (
    <nav className="space-nav" aria-label="这个空间">
      <ul className="list">
        {entries.map(([id, label, count]) => (
          <li key={id}>
            <button
              type="button"
              className="row"
              aria-current={props.section === id ? 'page' : undefined}
              data-waiting={id === 'review' && props.pending > 0}
              aria-label={count === undefined ? undefined : `${label}（${count}）`}
              onClick={() => props.onShow(id)}
            >
              {label}
              {/* Read aloud as “待确认（3）”; seen as a small count at the end of the row. */}
              {count !== undefined && (
                <span className="count" aria-hidden="true">
                  {count}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
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
  nav: ReactNode
  sessions: readonly Session[]
  thread: string | undefined
  plans: ReactNode
  guard: (work: () => Promise<unknown>) => void
  identity: ReactNode
  connect: ReactNode
  onSpaces: (spaces: readonly Space[], selected?: string) => void
  onSelectSpace: (id: string) => void
  onSelectThread: (id: string) => void
  onNewThread: () => void
}) {
  const { spaces, current, sessions, guard } = props
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<string>()
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

  return (
    <aside className="shelf" aria-label="空间">
      <h1 className="wordmark">
        <img src="./icon.svg" alt="" />
        Episteme
      </h1>
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
          <button type="submit" className="secondary">
            新建
          </button>
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
            <h2>这个空间</h2>
            {props.nav}
          </section>
          {props.plans}
          <section>
            <h2>对话</h2>
            <ThreadTree
              sessions={sessions}
              current={props.thread}
              onSelect={props.onSelectThread}
            />

            <button type="button" className="link" onClick={props.onNewThread}>
              开始新对话
            </button>
          </section>
        </>
      )}
      <footer className="shelf-foot">{props.connect}</footer>
    </aside>
  )
}

/**
 * A space's conversations as their branches make them: each branch under the line it left, oldest first. Folding a
 * line hides its branches, not itself; opening a conversation unfolds the lines above it, so it shows where it came
 * from. A list with no branches looks as it always did.
 */
function ThreadTree(props: {
  sessions: readonly Session[]
  current: string | undefined
  onSelect: (id: string) => void
}) {
  const { sessions, current } = props
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const below = new Map<string, Session[]>()
  const roots: Session[] = []
  for (const session of sessions) {
    const parent = session.parent?.thread
    // A branch whose line is not listed here (archived, or a plan's) stands on its own.
    if (parent === undefined || parent === session.id || !byId.has(parent)) roots.push(session)
    else below.set(parent, [...(below.get(parent) ?? []), session])
  }
  for (const branches of below.values()) branches.sort((a, b) => a.createdAt - b.createdAt)

  /** The lines the conversation on show came from, nearest first. */
  const above: string[] = []
  for (
    let line = byId.get(current ?? '')?.parent?.thread;
    line !== undefined && byId.has(line) && !above.includes(line);
    line = byId.get(line)?.parent?.thread
  ) {
    above.push(line)
  }
  const aboveKey = above.join(' ')
  useEffect(() => {
    if (aboveKey === '') return
    setFolded((held) => {
      const lines = aboveKey.split(' ')
      if (!lines.some((line) => held.has(line))) return held
      return new Set([...held].filter((line) => !lines.includes(line)))
    })
  }, [aboveKey])

  const branchCount = (id: string): number =>
    (below.get(id) ?? []).reduce((sum, branch) => sum + 1 + branchCount(branch.id), 0)
  const branched = below.size > 0

  const lines = (list: readonly Session[], nested: boolean): ReactNode => (
    <ul className={nested ? 'thread-tree thread-branches' : 'list thread-tree'}>
      {list.map((session) => {
        const branches = below.get(session.id) ?? []
        const open = branches.length > 0 && !folded.has(session.id)
        return (
          <li key={session.id}>
            <div className="tree-item">
              {branches.length > 0 ? (
                <button
                  type="button"
                  className="tree-toggle"
                  aria-expanded={open}
                  aria-label={`${open ? '收起' : '展开'}《${session.title}》的分支`}
                  onClick={() =>
                    setFolded((held) => {
                      const next = new Set(held)
                      if (next.has(session.id)) next.delete(session.id)
                      else next.add(session.id)
                      return next
                    })
                  }
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path
                      d="M3 1.5 6.5 5 3 8.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : (
                branched && <span className="tree-spacer" aria-hidden="true" />
              )}
              <button
                type="button"
                className="row"
                aria-current={session.id === current}
                data-above={above.includes(session.id) ? 'true' : undefined}
                onClick={() => props.onSelect(session.id)}
              >
                <span className="tree-title">{session.title}</span>
                {branches.length > 0 && !open && (
                  <span className="row-note">{branchCount(session.id)} 个分支</span>
                )}
              </button>
            </div>
            {open && lines(branches, true)}
          </li>
        )
      })}
    </ul>
  )
  return lines(roots, false)
}

/** Where a branch left the conversation it came from, and what that conversation is called. */
interface BranchOf {
  readonly parent: { readonly thread: string; readonly turn: string }
  readonly title: string
}

function branchOf(sessions: readonly Session[], thread: string | undefined): BranchOf | undefined {
  const parent = sessions.find((session) => session.id === thread)?.parent
  if (parent === undefined) return undefined
  const title = sessions.find((session) => session.id === parent.thread)?.title ?? '原对话'
  return { parent, title }
}

function Conversation(props: {
  space: Space | undefined
  hasMaterial: boolean
  thread: string | undefined
  branchOf: BranchOf | undefined
  onForkPoint: (parent: BranchOf['parent']) => void
  turns: readonly Turn[]
  asking: boolean
  failed: { question: string; failure: Failure } | undefined
  onAsk: (question: string, retry: boolean) => void
  onCite: (citation: Citation, evidence?: Evidence) => void
  onCandidates: (reply: string) => Promise<string | undefined>
  onMaterials: () => void
  extract: ReactNode
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

  const { branchOf } = props
  // A conversation from before branching, or one that never branched, carries nothing over.
  const carried = turns.filter((turn) => turn.inherited === true)
  const own = turns.filter((turn) => turn.inherited !== true)
  const shown = (turn: Turn) =>
    turn.speaker === 'learner' ? (
      <LearnerTurn key={turn.id} turn={turn} thread={props.thread} />
    ) : (
      <AgentTurn
        key={turn.id}
        turn={turn}
        onCite={props.onCite}
        onCandidates={props.onCandidates}
      />
    )

  return (
    <>
      <div className="page">
        <h2 className="space-title">{space.name}</h2>
        {branchOf !== undefined && (
          <p className="hint branch-of">
            这是《{branchOf.title}》的一个分支，原对话不受影响。{' '}
            <button
              type="button"
              className="link"
              onClick={() => props.onForkPoint(branchOf.parent)}
            >
              回到分叉处
            </button>
          </p>
        )}
        {turns.length === 0 && (
          <p className="hint page-hint">
            {props.hasMaterial ? (
              '就材料提一个问题。回答里的每句话都会标明它从哪来。'
            ) : (
              <>
                先上传一份材料，再就它提问。{' '}
                <button type="button" className="link" onClick={props.onMaterials}>
                  去上传材料
                </button>
              </>
            )}
          </p>
        )}
        {turns.length > 0 && props.extract}
        {carried.length > 0 && (
          <>
            <section
              className="carried"
              aria-label={`继承自《${branchOf?.title ?? '原对话'}》的对话`}
            >
              {carried.map(shown)}
            </section>
            <p className="fork-line" role="separator">
              以上继承自《{branchOf?.title ?? '原对话'}》，以下是这个分支自己的对话
            </p>
            {own.length === 0 && !asking && (
              <p className="hint page-hint">在下面接着问，对话从这里继续。</p>
            )}
          </>
        )}
        {own.map(shown)}
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

const PAGE_NAMES: Partial<Record<Place['kind'], string>> = {
  space: '概览',
  materials: '材料',
  review: '待确认',
  understanding: '我的理解',
  new: '新对话',
  connect: '接入 Agent',
  model: '模型',
  conversations: '所有对话',
  unfiled: '未分类待确认',
  'agent-sessions': 'Agent 会话记录',
  commons: '公开成果',
}

/** Where the page is, as the title bar says it: the space, then the page or the conversation open in it. */
function crumbsOf(
  place: Place,
  names: {
    readonly space: string | undefined
    readonly thread: string | undefined
    readonly plan: string | undefined
  },
): readonly string[] {
  const page =
    place.kind === 'thread'
      ? (names.thread ?? '对话')
      : place.kind === 'plan'
        ? (names.plan ?? '学习计划')
        : PAGE_NAMES[place.kind]
  const inSpace = 'space' in place && names.space !== undefined
  return [inSpace ? names.space : undefined, page].filter(
    (crumb): crumb is string => crumb !== undefined,
  )
}

/** Two sheets, one solid and one dashed: what is held, and what waits above it. */
function LayerGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <rect
        x="2.5"
        y="7.5"
        width="11"
        height="6"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="2.5"
        y="2.5"
        width="11"
        height="6"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="2 1.6"
      />
    </svg>
  )
}

/**
 * The understanding layer, beside whatever page is open: what waits for the person's decision, and what they
 * already hold. Deciding here is the same as on the review page; only the person can do it.
 */
function Rail(props: {
  pending: readonly PendingCandidate[]
  held: readonly HeldNode[]
  guard: (work: () => Promise<unknown>) => void
  onDecided: () => Promise<void>
  onOpenNode: (node: string) => void
  onOpenAll: () => void
  onClose: () => void
}) {
  const { pending, held } = props
  return (
    <aside className="rail" aria-label="理解层">
      <div className="rail-head">
        <h2>理解层</h2>
        <button type="button" className="tool" onClick={props.onClose}>
          收起
        </button>
      </div>
      <div className="rail-body">
        <p className="rail-rule">Agent 只能提议。只有你确认过的，才算你的理解。</p>
        <section className="rail-section">
          <h3 data-waiting={pending.length > 0}>
            等你确认
            <span className="count">{pending.length}</span>
          </h3>
          {pending.length === 0 ? (
            <p className="rail-empty">现在没有等你确认的提议。Agent 提出的理解会先停在这里。</p>
          ) : (
            <PendingList pending={pending} guard={props.guard} onDecided={props.onDecided} />
          )}
        </section>
        <section className="rail-section">
          <h3>
            你已确认
            <span className="count">{held.length}</span>
          </h3>
          {held.length === 0 ? (
            <p className="rail-empty">还没有。确认一条提议，它就会出现在这里。</p>
          ) : (
            <ul className="held">
              {held.map((node) => (
                <li key={node.nodeId}>
                  <button type="button" onClick={() => props.onOpenNode(node.nodeId)}>
                    {node.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="rail-foot">
          <button type="button" className="link" onClick={props.onOpenAll}>
            打开理解图和每一条的来历
          </button>
        </p>
      </div>
    </aside>
  )
}

/** The side column holds one thing: the source text a citation or a material name opened. */
function Side(props: { source: SourceRequest | undefined; onClose: () => void }) {
  return (
    <aside className="side" aria-label="原文">
      <div className="side-head">
        <span>原文</span>
        {props.source !== undefined && (
          <button type="button" className="tool" onClick={props.onClose}>
            关上原文
          </button>
        )}
      </div>
      <div className="side-body">
        <SourceView request={props.source} />
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
  const { link, state } = candidate
  const decide = (work: () => Promise<unknown>): void => {
    guard(async () => {
      await work()
      await onDecided()
    })
  }
  if (state !== undefined) {
    return (
      <li>
        <p className="candidate">{state.label}</p>
        <p className="candidate">
          <span className="hint">把{state.dimension}记为：</span>
          {state.level}
        </p>
        <p className="hint">{candidate.rationale}</p>
        <p className="decisions">
          <button type="button" onClick={() => decide(() => api.accept(candidate.id))}>
            同意，记下来
          </button>
          <button
            type="button"
            className="link"
            onClick={() => decide(() => api.dismiss(candidate.id))}
          >
            不同意
          </button>
        </p>
      </li>
    )
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
