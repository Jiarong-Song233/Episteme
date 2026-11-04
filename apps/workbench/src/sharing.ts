import type { SceneView } from '@episteme/application'
import type { SceneRoute, SceneRouteContext } from '@episteme/service'
import { openSpaceOf, refuse, required, scopeOf, spaceOf, text } from './requests.js'
import {
  adoptionKey,
  adoptionsOf,
  CANDIDATE_REF,
  FORKS,
  heldNodes,
  HEADER,
  LEARNER,
  MAX_REASON,
  MAX_WORDS,
  refusalMessage,
  replyOf,
  REQUESTED_BY,
  submit,
  type Adoption,
} from './understanding.js'

/**
 * Working with what other people published (ADR 0014), on top of its publications.
 *
 * Publishing, withdrawing and adopting are the person's alone, so the page does those through the API's own routes.
 * What is here reads publications together, says where in a space a cited item sits, and turns a response into
 * suggestions, which the person's page then accepts. Nothing here reaches anyone else's words or state: a response is
 * the responder's own node with the responder's own edge pointing at the original.
 */

const RESPONSE_PREFIX = 'response/'
const KEPT_PREFIX = 'kept-update/'
const REVISES = 'evolves_to'

const RELATIONS = { forks: FORKS, contradicts: 'contradicts', supports: 'supports' } as const
type Stance = keyof typeof RELATIONS
const EDGE_TYPES: ReadonlySet<string> = new Set(Object.values(RELATIONS))

const RATIONALE: Readonly<Record<Stance, string>> = {
  forks: '你提出了自己的版本。原作者的内容不受影响。',
  contradicts: '你认为这一条和原作者的说法矛盾。',
  supports: '你认为这一条支持原作者的说法。',
}

/** What a person answered to a published item. Kept so the trace survives even if the author later withdraws it. */
interface Response {
  readonly suggestion: string
  readonly space: string
  readonly publication: string
  readonly target: string
  readonly author: string
  readonly relation: Stance
  readonly at: number
  readonly reason?: string
}

const responsesOf = (view: SceneView): readonly Response[] =>
  view.records.list(RESPONSE_PREFIX).map((record) => record.value as Response)

/** Live publications with their members, for reading them against each other. */
function livePublications(view: SceneView) {
  return view.browsePublications().flatMap((summary) => {
    const read = view.publicationView(summary.id)
    return read === undefined ? [] : [{ summary, read }]
  })
}

/** The publication a node was most recently published in. */
function publicationHolding(live: ReturnType<typeof livePublications>, node: string) {
  return live.find(({ read }) => read.nodes.some((member) => member.nodeId === node))?.summary
}

/** What others published in answer to these nodes. Only published responses: drafts of an answer stay private. */
function publishedResponses(
  live: ReturnType<typeof livePublications>,
  id: string,
  members: ReadonlySet<string>,
) {
  return live.flatMap(({ summary, read }) => {
    if (summary.id === id) return []
    return read.edges.flatMap((edge) => {
      const node = read.nodes.find((member) => member.nodeId === edge.from)
      if (node === undefined || !members.has(edge.to) || !EDGE_TYPES.has(edge.type)) return []
      return [
        {
          publication: summary.id,
          author: summary.author,
          node: node.nodeId,
          label: node.label,
          relation: edge.type,
          target: edge.to,
          ...(summary.note === undefined ? {} : { note: summary.note }),
        },
      ]
    })
  })
}

interface LineageStep {
  readonly nodeId?: string
  readonly label?: string
  readonly author: string
  readonly publication?: string
  /** How this step came from the one before it. */
  readonly relation?: string
  readonly reason?: string
  /** Its author withdrew it, so only who wrote it and where it was published is still known here. */
  readonly withdrawn?: true
}

/**
 * From a node back to where it started, across people.
 *
 * Follows what the person can see and stops at what they cannot: a withdrawn original is named by its author and
 * publication, which the person's own record of responding holds, and its words stay withdrawn.
 */
function lineageOf(view: SceneView, start: string): readonly LineageStep[] {
  const live = livePublications(view)
  const nodes = view.listNodes()
  const responses = responsesOf(view)
  const steps: LineageStep[] = []
  const seen = new Set<string>()
  let current: string | undefined = start
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const here: string = current
    const expanded = view.expand(here)
    if (expanded === undefined) break
    const listed = nodes.find((node) => node.nodeId === here)
    const response = responses.find((candidate) => candidate.suggestion === listed?.fromSuggestion)
    const fork = expanded.neighbours.find(
      (neighbour) => neighbour.type === FORKS && neighbour.direction === 'out',
    )
    const revisedFrom = expanded.neighbours.find(
      (neighbour) => neighbour.type === REVISES && neighbour.direction === 'in',
    )
    const responded =
      response !== undefined && view.expand(response.target) !== undefined
        ? response.target
        : undefined
    const relation =
      fork !== undefined
        ? FORKS
        : revisedFrom !== undefined
          ? REVISES
          : response === undefined
            ? undefined
            : RELATIONS[response.relation]
    const holding = publicationHolding(live, here)
    // The person's own record says why. Anyone else knows only what its author chose to publish with it.
    const reason = response?.reason ?? (relation === undefined ? undefined : holding?.note)
    steps.push({
      nodeId: here,
      label: expanded.label,
      author: expanded.author,
      ...(holding === undefined ? {} : { publication: holding.id }),
      ...(relation === undefined ? {} : { relation }),
      ...(reason === undefined ? {} : { reason }),
    })
    current = fork?.nodeId ?? revisedFrom?.nodeId ?? responded
    if (current === undefined && response !== undefined) {
      steps.push({ author: response.author, publication: response.publication, withdrawn: true })
    }
  }
  return steps.reverse()
}

export interface SharingOptions {
  readonly now: () => number
}

export function sharingRoutes({ now }: SharingOptions): readonly SceneRoute[] {
  const route = (
    method: SceneRoute['method'],
    path: string,
    handle: SceneRoute['handle'],
  ): SceneRoute => ({ method, path, handle })

  /** Says where in a space a cited item sits. Only after the adoption itself exists, as the graph records it. */
  function cite({ view, body }: SceneRouteContext) {
    const space = openSpaceOf(view, text(body, 'space'))
    const publication = text(body, 'publication')
    const node = text(body, 'node')
    const adopted = (view.historyOf(node) ?? []).some(
      (event) => event.source === `publication:${publication}`,
    )
    if (!adopted) refuse('not_adopted', '先记下你对这一条的把握，才能把它放进空间。')
    const author = view
      .publicationView(publication)
      ?.nodes.find((member) => member.nodeId === node)?.author
    if (author === undefined) refuse('not_a_member', '这份成果里没有这一条，或者它已被作者撤回。')
    const adoption: Adoption = { space: space.id, node, publication, author, at: now() }
    return view.records.put(adoptionKey(space.id, node), adoption).then(() => ({ adoption }))
  }

  /**
   * The person's own words in answer to a published item, as suggestions for them to accept.
   *
   * The edge points from their node to the original, whoever's it is, so publishing their node carries it and the
   * original stays exactly as its author left it.
   */
  async function respond({ view, writes, body }: SceneRouteContext) {
    const space = openSpaceOf(view, text(body, 'space'))
    const publication = text(body, 'publication')
    const node = text(body, 'node')
    const relation = text(body, 'relation') as Stance
    if (!Object.hasOwn(RELATIONS, relation)) refuse('invalid_request', '不认识这种回应。')
    const read = view.publicationView(publication)
    if (read === undefined || !read.live) refuse('not_live', '这份成果已经撤回，不能再回应。')
    const target = read.nodes.find((member) => member.nodeId === node)
    if (target === undefined) refuse('not_a_member', '这份成果里没有这一条。')
    if (target.author === writes.actor) {
      refuse('own_publication', '这是你自己发布的。要改，请在“我的理解”里修正。')
    }
    const label = text(body, 'label', MAX_WORDS).trim()
    if (label === target.label) refuse('unchanged', '你的说法和原来的一样。')
    const reason =
      typeof body['reason'] === 'string' ? body['reason'].trim().slice(0, MAX_REASON) : ''
    const at = now()
    const outcome = await submit(
      view,
      space.id,
      { title: `回应：${target.label}`.slice(0, 80), text: `${HEADER}${LEARNER}: ${label}\n` },
      [
        {
          kind: 'node',
          ref: 'new',
          role: 'claim',
          label,
          quote: label,
          basis: 'stated',
          rationale: reason === '' ? RATIONALE[relation] : reason,
        },
      ],
      () => ({
        at,
        speaker: 'learner',
        basis: 'stated',
        ...(reason === '' ? {} : { reason }),
      }),
    )
    const [made] = outcome.suggestions
    if (made === undefined) {
      refuse('not_saved', refusalMessage(outcome.refused) ?? '这条回应没能保存。')
    }
    const link = await view.propose(
      {
        kind: 'link',
        from: `${CANDIDATE_REF}${made.id}`,
        to: node,
        relation: RELATIONS[relation],
      },
      {
        proposedBy: REQUESTED_BY,
        rationale: reason === '' ? RATIONALE[relation] : reason,
        scope: scopeOf(space.id),
      },
    )
    if (!link.ok) refuse(link.refusal.code, '这条回应没能和原来的成果连起来。')
    const response: Response = {
      suggestion: made.id,
      space: space.id,
      publication,
      target: node,
      author: target.author,
      relation,
      at,
      ...(reason === '' ? {} : { reason }),
    }
    await view.records.put(`${RESPONSE_PREFIX}${made.id}`, response)
    return replyOf({
      suggestions: [...outcome.suggestions, link.suggestion],
      refused: outcome.refused,
    })
  }

  return [
    // What publishing this item would involve, beyond what the API's preview says: what it could carry along, and
    // which earlier publication it would be a new version of.
    route('GET', '/sharing/publishable', ({ view, writes, query }) => {
      const space = spaceOf(view, required(query, 'space'))
      const nodes = heldNodes(view, space.id)
      const id = required(query, 'node')
      const node = nodes.find((candidate) => candidate.nodeId === id)
      if (node === undefined) refuse('unknown_node', '这个空间里没有这条理解。')
      if (node.adoptedFrom !== undefined) {
        refuse('not_your_words', '这一条是别人发布的。你可以发布自己的版本。')
      }
      const mine = view.browsePublications({ author: writes.actor })
      const holding = mine.flatMap((summary) => {
        const read = view.publicationView(summary.id)
        return read === undefined
          ? []
          : [{ summary, members: new Set<string>(read.publication.members) }]
      })
      const published = holding.find(({ members }) => members.has(node.nodeId))?.summary
      // The nearest earlier wording that is out there: this is its next version, if the person wants it to be.
      const walked = new Set<string>([node.nodeId])
      let earlier: { readonly id: string; readonly rootLabel: string } | undefined
      let cursor = node
      while (earlier === undefined) {
        const parent = cursor.relations.find(
          (relation) => relation.type === REVISES && relation.direction === 'in',
        )
        const next = nodes.find((candidate) => candidate.nodeId === parent?.nodeId)
        if (next === undefined || walked.has(next.nodeId)) break
        walked.add(next.nodeId)
        cursor = next
        const found = holding.find(({ members }) => members.has(next.nodeId))?.summary
        if (found !== undefined) earlier = { id: found.id, rootLabel: found.rootLabel }
      }
      const made = view.listNodes().find((listed) => listed.nodeId === node.nodeId)?.fromSuggestion
      const reason = responsesOf(view).find((response) => response.suggestion === made)?.reason
      return {
        ...(reason === undefined ? {} : { reason }),
        related: node.relations.flatMap((relation) => {
          const other = nodes.find((candidate) => candidate.nodeId === relation.nodeId)
          return other === undefined || other.adoptedFrom !== undefined || other.withdrawn
            ? []
            : [{ nodeId: other.nodeId, label: other.label, type: relation.type }]
        }),
        ...(published === undefined ? {} : { published: published.id }),
        ...(earlier === undefined ? {} : { earlier }),
      }
    }),

    route('GET', '/sharing/publication', ({ view, query }) => {
      const id = required(query, 'id')
      const read = view.publicationView(id)
      if (read === undefined) refuse('unknown_publication', '这份成果不存在，或者已被作者撤回。')
      const members = new Set<string>(read.publication.members)
      const nodes = view.listNodes()
      return {
        ...read,
        responses: publishedResponses(livePublications(view), id, members),
        // The person's own answers, published or not: only they ever see this part.
        answered: responsesOf(view).flatMap((response) => {
          if (!members.has(response.target)) return []
          const made = nodes.find((node) => node.fromSuggestion === response.suggestion)
          return made === undefined
            ? []
            : [
                {
                  node: made.nodeId,
                  label: made.label,
                  relation: RELATIONS[response.relation],
                  target: response.target,
                  space: response.space,
                },
              ]
        }),
        cited: adoptionsOf(view)
          .filter((adoption) => members.has(adoption.node))
          .map(({ node, space, publication }) => ({ node, space, publication })),
      }
    }),

    route('GET', '/sharing/lineage', ({ view, query }) => ({
      steps: lineageOf(view, required(query, 'node')),
    })),

    route('GET', '/sharing/updates', ({ view }) => {
      const kept = new Set(view.records.list(KEPT_PREFIX).map((record) => record.value as string))
      const cited = new Set(adoptionsOf(view).map((adoption) => adoption.publication))
      const labelOf = (id: string): string => view.expand(id)?.label ?? ''
      return {
        updates: view
          .updates()
          .filter(({ newer }) => !kept.has(newer) && !cited.has(newer))
          .map(({ adopted, newer, added, removed }) => ({
            adopted,
            newer,
            author: view.publicationView(newer)?.publication.actorId ?? '',
            added: added.map((nodeId) => ({ nodeId, label: labelOf(nodeId) })),
            removed: removed.map((nodeId) => ({ nodeId, label: labelOf(nodeId) })),
          })),
      }
    }),
    route('POST', '/sharing/updates/keep', async ({ view, body }) => {
      const newer = text(body, 'newer')
      await view.records.put(`${KEPT_PREFIX}${newer}`, newer)
      return { kept: newer }
    }),

    route('POST', '/sharing/cite', cite),
    route('POST', '/sharing/respond', respond),
  ]
}
