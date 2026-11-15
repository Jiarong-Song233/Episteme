import { useRoute } from 'wouter'

/**
 * Where a person is on the page, written in its address so a refresh, the back button and a pasted link all land
 * in the same place. The service answers 404 for any path it has no file for, so a page lives in the hash. An
 * address holds ids only: the words of a citation travel in the history entry instead.
 */

/** The first-level destinations shown beside every page of the published workbench. */
export type VisionKind =
  | 'desk'
  | 'learning-spaces'
  | 'network'
  | 'review-center'
  | 'learning-flow'
  | 'shared-outcomes'
  | 'my-materials'
  | 'client'

export type VisionPlace =
  | { readonly kind: 'desk'; readonly space?: string }
  | { readonly kind: 'learning-spaces'; readonly space?: string }
  | { readonly kind: 'network'; readonly space?: string; readonly node?: string }
  | { readonly kind: 'review-center'; readonly space?: string }
  | { readonly kind: 'learning-flow'; readonly space?: string; readonly plan?: string }
  | { readonly kind: 'shared-outcomes'; readonly space?: string }
  | { readonly kind: 'my-materials'; readonly space?: string }
  | { readonly kind: 'client'; readonly space?: string }

export const VISION_KINDS: readonly VisionKind[] = [
  'desk',
  'learning-spaces',
  'network',
  'review-center',
  'learning-flow',
  'shared-outcomes',
  'my-materials',
  'client',
]

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
  | VisionPlace

export function isVisionPlace(place: Place): place is VisionPlace {
  return VISION_KINDS.some((kind) => kind === place.kind)
}

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

const optional = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

export function usePlace(): Place {
  const [connect] = useRoute('/connect')
  const [modelPage] = useRoute('/model')
  const [conversations] = useRoute('/conversations')
  const [unfiled] = useRoute('/unfiled')
  const [, agentSessions] = useRoute('/agent-sessions/:agent?/:session?')
  const [, commons] = useRoute('/commons/:publication?')
  const [, desk] = useRoute('/desk/:space?')
  const [, learningSpaces] = useRoute('/learning-spaces/:space?')
  const [, network] = useRoute('/network/:space?/:node?')
  const [, reviewCenter] = useRoute('/review-center/:space?')
  const [, learningFlow] = useRoute('/learning-flow/:space?/:plan?')
  const [, sharedOutcomes] = useRoute('/shared-outcomes/:space?')
  const [, myMaterials] = useRoute('/my-materials/:space?')
  const [, client] = useRoute('/client/:space?')
  const [, thread] = useRoute('/spaces/:space/threads/:thread')
  const [, plan] = useRoute('/spaces/:space/plans/:plan')
  const [, fresh] = useRoute('/spaces/:space/new')
  const [, materials] = useRoute('/spaces/:space/materials')
  const [, review] = useRoute('/spaces/:space/review')
  const [, understanding] = useRoute('/spaces/:space/understanding/:node?')
  const [, space] = useRoute('/spaces/:space')
  if (desk !== null)
    return { kind: 'desk', ...(optional(desk.space) === undefined ? {} : { space: desk.space }) }
  if (learningSpaces !== null)
    return {
      kind: 'learning-spaces',
      ...(optional(learningSpaces.space) === undefined ? {} : { space: learningSpaces.space }),
    }
  if (network !== null)
    return {
      kind: 'network',
      ...(optional(network.space) === undefined ? {} : { space: network.space }),
      ...(optional(network.node) === undefined ? {} : { node: network.node }),
    }
  if (reviewCenter !== null)
    return {
      kind: 'review-center',
      ...(optional(reviewCenter.space) === undefined ? {} : { space: reviewCenter.space }),
    }
  if (learningFlow !== null)
    return {
      kind: 'learning-flow',
      ...(optional(learningFlow.space) === undefined ? {} : { space: learningFlow.space }),
      ...(optional(learningFlow.plan) === undefined ? {} : { plan: learningFlow.plan }),
    }
  if (sharedOutcomes !== null)
    return {
      kind: 'shared-outcomes',
      ...(optional(sharedOutcomes.space) === undefined ? {} : { space: sharedOutcomes.space }),
    }
  if (myMaterials !== null)
    return {
      kind: 'my-materials',
      ...(optional(myMaterials.space) === undefined ? {} : { space: myMaterials.space }),
    }
  if (client !== null)
    return {
      kind: 'client',
      ...(optional(client.space) === undefined ? {} : { space: client.space }),
    }
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

function visionPath(kind: VisionKind, space?: string, extra?: string): string {
  const part = encodeURIComponent
  return [
    `/${kind}`,
    ...(space === undefined ? [] : [`/${part(space)}`]),
    ...(extra === undefined ? [] : [`/${part(extra)}`]),
  ].join('')
}

/** A direct hash link for the first-level navigation, with the space it should read. */
export function visionHref(kind: VisionKind, space?: string, extra?: string): string {
  return `#${visionPath(kind, space, extra)}`
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
    case 'desk':
      return visionPath('desk', place.space)
    case 'learning-spaces':
      return visionPath('learning-spaces', place.space)
    case 'network':
      return visionPath('network', place.space, place.node)
    case 'review-center':
      return visionPath('review-center', place.space)
    case 'learning-flow':
      return visionPath('learning-flow', place.space, place.plan)
    case 'shared-outcomes':
      return visionPath('shared-outcomes', place.space)
    case 'my-materials':
      return visionPath('my-materials', place.space)
    case 'client':
      return visionPath('client', place.space)
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
  const named = 'space' in place ? place.space : undefined
  if (typeof named !== 'string') return undefined
  const query = new URLSearchParams(search)
  const node = query.get('node')
  if (node !== null) return { kind: 'understanding', space: named, node }
  const side = query.get('side')
  if (side === 'pending') return { kind: 'review', space: named }
  if (side === 'understood') return { kind: 'understanding', space: named }
  return undefined
}

export function opensSide(panel: Panel): boolean {
  return panel.material !== undefined
}
