import { useRoute } from 'wouter'

/**
 * Where a person is on the page, written in its address so a refresh, the back button and a pasted link all land
 * in the same place. The service answers 404 for any path it has no file for, so a page lives in the hash. An
 * address holds ids only: the words of a citation travel in the history entry instead.
 */

export type SideTab = 'source' | 'pending' | 'understood' | 'status'

export type Place =
  | { readonly kind: 'home' }
  | { readonly kind: 'commons'; readonly publication?: string }
  /** A space with nothing chosen in it yet, which resolves to where the person left off. */
  | { readonly kind: 'space'; readonly space: string }
  | { readonly kind: 'new'; readonly space: string }
  | { readonly kind: 'thread'; readonly space: string; readonly thread: string }
  | { readonly kind: 'plan'; readonly space: string; readonly plan: string }

/** What the side column shows and which words are in focus, alongside whichever place is open. */
export interface Panel {
  readonly side?: SideTab
  readonly node?: string
  readonly material?: string
  readonly turn?: string
}

const SIDE_TABS: readonly string[] = ['pending', 'understood', 'status', 'source']

export function usePlace(): Place {
  const [, commons] = useRoute('/commons/:publication?')
  const [, thread] = useRoute('/spaces/:space/threads/:thread')
  const [, plan] = useRoute('/spaces/:space/plans/:plan')
  const [, fresh] = useRoute('/spaces/:space/new')
  const [, space] = useRoute('/spaces/:space')
  if (commons !== null) {
    const { publication } = commons
    return publication === undefined ? { kind: 'commons' } : { kind: 'commons', publication }
  }
  if (thread !== null) return { kind: 'thread', space: thread.space, thread: thread.thread }
  if (plan !== null) return { kind: 'plan', space: plan.space, plan: plan.plan }
  if (fresh !== null) return { kind: 'new', space: fresh.space }
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
    case 'space':
      return `/spaces/${part(place.space)}`
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
  if (panel.side !== undefined && panel.side !== 'source') query.set('side', panel.side)
  if (panel.node !== undefined) query.set('node', panel.node)
  if (panel.material !== undefined) query.set('material', panel.material)
  if (panel.turn !== undefined) query.set('turn', panel.turn)
  return `${pathOf(place)}?${query}`
}

export function panelOf(search: string): Panel {
  const query = new URLSearchParams(search)
  const side = query.get('side')
  const node = query.get('node')
  const material = query.get('material')
  const turn = query.get('turn')
  return {
    ...(side !== null && SIDE_TABS.includes(side) ? { side: side as SideTab } : {}),
    ...(node === null ? {} : { node }),
    ...(material === null ? {} : { material }),
    ...(turn === null ? {} : { turn }),
  }
}

export function opensSide(panel: Panel): boolean {
  return panel.side !== undefined || panel.node !== undefined || panel.material !== undefined
}
