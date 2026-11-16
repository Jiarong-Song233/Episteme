import { SessionRefusal } from '@episteme/application'
import type { SceneRoute } from '../profile.js'

export const CAPTURE_SCENES = ['dev', 'learn', 'discussion'] as const
export type CaptureScene = (typeof CAPTURE_SCENES)[number]

/** A stable scene prefix with an optional application context, not an access-control boundary. */
export function noteScope(scene: CaptureScene, input: unknown): string {
  const base = `scene:${scene}`
  if (input === undefined || input === '') return base
  if (typeof input !== 'string' || input.trim() === '') {
    throw new SessionRefusal('invalid_scope', 'scope must be a nonempty string')
  }
  const scope = input.trim()
  if (scope.startsWith('scene:') && scope !== base && !scope.startsWith(`${base}:`)) {
    throw new SessionRefusal('invalid_scope', `scope must belong to ${base}`)
  }
  return scope.startsWith('scene:') ? scope : `${base}:${scope}`
}

/** Small, sourced proposals for every capture surface; full host readings go through MCP distill. */
export function noteRoutes(scene: CaptureScene, path = '/notes'): readonly SceneRoute[] {
  return [
    {
      method: 'POST',
      path,
      handle: async ({ view, body }) => {
        const text = body['text']
        if (typeof text !== 'string' || text.trim().length < 2 || text.trim().length > 1000) {
          throw new SessionRefusal(
            'invalid_request',
            'text must contain 2–1000 characters; select a shorter passage',
          )
        }
        const label = text.trim()
        const why = typeof body['why'] === 'string' ? body['why'].trim() : ''
        const source = typeof body['source'] === 'string' ? body['source'].trim() : ''
        const scope = noteScope(scene, body['scope'])
        const outcome = await view.distill(
          { title: source || `${scene} note`, text: label },
          {
            requestedBy: 'ep-cli',
            scope,
            host: {
              candidates: [
                {
                  kind: 'node',
                  ref: 'note',
                  role: 'claim',
                  label,
                  quote: label,
                  basis: 'inferred',
                  rationale: why || 'A passage selected for human review',
                },
              ],
            },
          },
        )
        if (!outcome.ok) throw new SessionRefusal(outcome.refusal.code, outcome.refusal.message)
        const suggestion = outcome.suggestions[0]
        if (suggestion === undefined) {
          const refusal = outcome.refused[0]
          throw new SessionRefusal(
            refusal?.code ?? 'no_candidate',
            refusal?.message ?? 'No candidate was kept',
          )
        }
        return { suggestionId: suggestion.id, sourceId: outcome.sourceId, scope }
      },
    },
    {
      method: 'GET',
      path,
      handle: ({ view, query }) => {
        const base = `scope:scene:${scene}`
        const exact = query.has('scope')
          ? `scope:${noteScope(scene, query.get('scope'))}`
          : undefined
        return {
          notes: view
            .listNodes()
            .filter((node) =>
              node.tags.some((tag) =>
                exact === undefined ? tag === base || tag.startsWith(`${base}:`) : tag === exact,
              ),
            )
            .map((node) => {
              const dimensions = view.understandingOf(node.nodeId) ?? []
              return {
                nodeId: node.nodeId,
                label: node.label,
                scene,
                tags: node.tags,
                dimensions,
                validity: dimensions.find((dimension) => dimension.id === 'validity')?.level,
                agreement: dimensions.find((dimension) => dimension.id === 'agreement')?.level,
              }
            }),
        }
      },
    },
  ]
}
