import { useRoute } from 'wouter'

/**
 * Where a person is on the page, written in its address so a refresh, the back button and a pasted link all land
 * in the same place. The service answers 404 for any path it has no file for, so a page lives in the hash. An
 * address holds ids only: the words of a citation travel in the history entry instead.
 */

export type Place =
  | { readonly kind: 'home' }
  | { readonly kind: 'commons'; readonly publication?: string }
  /** How an agent connects to this service. */
  | { readonly kind: 'connect' }
  /** Which language model writes the answers. */
  | { readonly kind: 'model' }
  /** Every conversation of the workbench, to rename and archive. */
  | { readonly kind: 'conversations' }
  /** What waits for the person's decision but was proposed outside any space. */
  | { readonly kind: 'unfiled' }
  /** The conversations the agents of this computer keep, or one of them. */
  | { readonly kind: 'agent-sessions'; readonly agent?: string; readonly session?: string }
  /** A space's overview: what waits for the person, what is still a gap, and what came of learning lately. */
  | { readonly kind: 'space'; readonly space: string }
  /** What the space learns from. */
  | { readonly kind: 'materials'; readonly space: string }
  /** What waits for the person's own decision. */
  | { readonly kind: 'review'; readonly space: string }
  /** What the person holds, or one item of it. */
  | { readonly kind: 'understanding'; readonly space: string; readonly node?: string }
  | { readonly kind: 'new'; readonly space: string }
  | { readonly kind: 'thread'; readonly space: string; readonly thread: string }
  | { readonly kind: 'plan'; readonly space: string; readonly plan: string }

/** The page a place belongs to, for the space's own navigation. */
export type Section = 'overview' | 'materials' | 'review' | 'understanding' | 'learning'

export function sectionOf(place: Place): Section | undefined {
  switch (place.kind) {
    case 'space':
      return 'overview'
    case 'materials':
      return 'materials'
    case 'review':
      return 'review'
    case 'understanding':
      return 'understanding'
    case 'new':
    case 'thread':
    case 'plan':
      return 'learning'
    default:
      return undefined
  }
}

/** Beside whichever place is open: the material in the side column, and the words in focus. */
export interface Panel {
  readonly material?: string
  readonly turn?: string
}

export function usePlace(): Place {
  const [connect] = useRoute('/connect')
  const [modelPage] = useRoute('/model')
  const [conversations] = useRoute('/conversations')
  const [unfiled] = useRoute('/unfiled')
  const [, agentSessions] = useRoute('/agent-sessions/:agent?/:session?')
  const [, commons] = useRoute('/commons/:publication?')
  const [, thread] = useRoute('/spaces/:space/threads/:thread')
  const [, plan] = useRoute('/spaces/:space/plans/:plan')
  const [, fresh] = useRoute('/spaces/:space/new')
  const [, materials] = useRoute('/spaces/:space/materials')
  const [, review] = useRoute('/spaces/:space/review')
  const [, understanding] = useRoute('/spaces/:space/understanding/:node?')
  const [, space] = useRoute('/spaces/:space')
  if (connect) return { kind: 'connect' }
  if (modelPage) return { kind: 'model' }
  if (conversations) return { kind: 'conversations' }
  if (unfiled) return { kind: 'unfiled' }
  if (agentSessions !== null) {
    const { agent, session } = agentSessions
    return {
      kind: 'agent-sessions',
      ...(agent === undefined ? {} : { agent }),
      ...(agent === undefined || session === undefined ? {} : { session }),
    }
  }
  if (commons !== null) {
    const { publication } = commons
    return publication === undefined ? { kind: 'commons' } : { kind: 'commons', publication }
  }
  if (thread !== null) return { kind: 'thread', space: thread.space, thread: thread.thread }
  if (plan !== null) return { kind: 'plan', space: plan.space, plan: plan.plan }
  if (fresh !== null) return { kind: 'new', space: fresh.space }
  if (materials !== null) return { kind: 'materials', space: materials.space }
  if (review !== null) return { kind: 'review', space: review.space }
  if (understanding !== null) {
    const { node } = understanding
    return node === undefined
      ? { kind: 'understanding', space: understanding.space }
      : { kind: 'understanding', space: understanding.space, node }
  }
  if (space !== null) return { kind: 'space', space: space.space }
  return { kind: 'home' }
}

function pathOf(place: Place): string {
  const part = encodeURIComponent
  switch (place.kind) {
    case 'home':
      return '/'
    case 'commons':
      return place.publication === undefined ? '/commons' : `/commons/${part(place.publication)}`
    case 'connect':
      return '/connect'
    case 'model':
      return '/model'
    case 'conversations':
      return '/conversations'
    case 'unfiled':
      return '/unfiled'
    case 'agent-sessions':
      return place.agent === undefined
        ? '/agent-sessions'
        : place.session === undefined
          ? `/agent-sessions/${part(place.agent)}`
          : `/agent-sessions/${part(place.agent)}/${part(place.session)}`
    case 'space':
      return `/spaces/${part(place.space)}`
    case 'materials':
      return `/spaces/${part(place.space)}/materials`
    case 'review':
      return `/spaces/${part(place.space)}/review`
    case 'understanding':
      return place.node === undefined
        ? `/spaces/${part(place.space)}/understanding`
        : `/spaces/${part(place.space)}/understanding/${part(place.node)}`
    case 'new':
      return `/spaces/${part(place.space)}/new`
    case 'thread':
      return `/spaces/${part(place.space)}/threads/${part(place.thread)}`
    case 'plan':
      return `/spaces/${part(place.space)}/plans/${part(place.plan)}`
  }
}

/** Always ends in a query, even an empty one, because the router otherwise keeps the one already there. */
export function hrefOf(place: Place, panel: Panel): string {
  const query = new URLSearchParams()
  if (panel.material !== undefined) query.set('material', panel.material)
  if (panel.turn !== undefined) query.set('turn', panel.turn)
  return `${pathOf(place)}?${query}`
}

export function panelOf(search: string): Panel {
  const query = new URLSearchParams(search)
  const material = query.get('material')
  const turn = query.get('turn')
  return {
    ...(material === null ? {} : { material }),
    ...(turn === null ? {} : { turn }),
  }
}

/**
 * Links made before review and understanding had pages of their own kept them in the side column's query. They
 * still land where they meant to.
 */
export function olderPlace(place: Place, search: string): Place | undefined {
  if (!('space' in place)) return undefined
  const query = new URLSearchParams(search)
  const node = query.get('node')
  if (node !== null) return { kind: 'understanding', space: place.space, node }
  const side = query.get('side')
  if (side === 'pending') return { kind: 'review', space: place.space }
  if (side === 'understood') return { kind: 'understanding', space: place.space }
  return undefined
}

export function opensSide(panel: Panel): boolean {
  return panel.material !== undefined
}
