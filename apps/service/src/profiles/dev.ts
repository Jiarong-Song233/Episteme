import {
  defaultDistillationPolicy,
  defaultSessionPack,
  recordableDimensions,
  SessionRefusal,
  type SessionScene,
} from '@episteme/application'
import {
  asId,
  defineDomainPack,
  type DimensionId,
  type StateDimensionDefinition,
} from '@episteme/core'
import { BLANK_TOPIC, type SceneProfile, type SceneRoute, type SeedTopic } from '../profile.js'

/**
 * The dev scene: keeping engineering decisions, lessons and the evidence behind them.
 *
 * It reuses the universal units (`concept` / `claim` / `evidence` / `question`) and adds one axis of its own,
 * `validity`, so a lesson can move untested → tested → in-prod → deprecated without ever becoming a single
 * mastery score. Nothing here changes Core; it is one profile over the same review path (ADR 0013), shaped after
 * `apps/hypothesis`.
 */

const VALIDITY: StateDimensionDefinition = {
  id: asId<DimensionId>('validity'),
  label: 'Validity',
  kind: 'categorical',
  levels: ['untested', 'tested', 'in-prod', 'deprecated'],
}

export const devScene: SessionScene = {
  name: 'dev',
  packs: [defaultSessionPack, defineDomainPack('dev', { stateDimensions: [VALIDITY] })],
  distillationPolicy: defaultDistillationPolicy,
  recordableDimensions: recordableDimensions(
    [VALIDITY],
    [
      {
        id: VALIDITY.id,
        labelZh: '有效性',
        levelLabelsZh: {
          untested: '未验证',
          tested: '已验证',
          'in-prod': '已上线',
          deprecated: '已废弃',
        },
        description: 'How far this lesson is trusted in practice.',
        descriptionZh: '这条经验在实践中有多可信。',
      },
    ],
  ),
}

const PROPOSED_BY = 'ep-cli'

function textOf(body: Readonly<Record<string, unknown>>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SessionRefusal('invalid_request', `"${name}" is required`)
  }
  return value.trim()
}

const routes: readonly SceneRoute[] = [
  {
    // A proposed lesson. It becomes the person's understanding only after `accept`, through the one
    // decision path every channel shares; an agent (or the CLI acting as one) never confirms its own draft.
    method: 'POST',
    path: '/notes',
    handle: async ({ view, body }) => {
      const scope =
        typeof body['scope'] === 'string' && body['scope'].trim() !== ''
          ? { scope: body['scope'].trim() }
          : {}
      const outcome = await view.propose(
        { kind: 'claim', label: textOf(body, 'text') },
        {
          proposedBy: PROPOSED_BY,
          rationale:
            typeof body['why'] === 'string' && body['why'].trim() !== ''
              ? body['why'].trim()
              : 'proposed from ep cli',
          ...scope,
        },
      )
      if (!outcome.ok) throw new SessionRefusal(outcome.refusal.code, outcome.refusal.message)
      return { suggestionId: outcome.suggestion.id }
    },
  },
  {
    method: 'GET',
    path: '/notes',
    handle: ({ view }) => ({
      notes: view.listNodes().map((node) => ({
        nodeId: node.nodeId,
        label: node.label,
        validity: view
          .understandingOf(node.nodeId)
          ?.find((dimension) => dimension.id === VALIDITY.id)?.level,
      })),
    }),
  },
]

export function devProfile(seed: SeedTopic = BLANK_TOPIC): SceneProfile {
  return { name: 'dev', seed, scene: devScene, routes }
}
