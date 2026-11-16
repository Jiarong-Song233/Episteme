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
 * The discussion scene: keeping the positions people take in a conversation, and how far they agree, so the
 * disagreement survives the thread and can be recalled later.
 *
 * It reuses the universal units and adds one axis, `agreement` (none → partial → full). A position is proposed
 * like any other claim and confirmed by the person; the raw conversation stays a thread (ADR 0015), which is
 * what a later distillation reads.
 */

const AGREEMENT: StateDimensionDefinition = {
  id: asId<DimensionId>('agreement'),
  label: 'Agreement',
  kind: 'categorical',
  levels: ['none', 'partial', 'full'],
}

export const discussionScene: SessionScene = {
  name: 'discussion',
  packs: [defaultSessionPack, defineDomainPack('discussion', { stateDimensions: [AGREEMENT] })],
  distillationPolicy: defaultDistillationPolicy,
  recordableDimensions: recordableDimensions(
    [AGREEMENT],
    [
      {
        id: AGREEMENT.id,
        labelZh: '一致程度',
        levelLabelsZh: { none: '无一致', partial: '部分一致', full: '完全一致' },
        description: 'How far the participants ended up agreeing on this position.',
        descriptionZh: '参与者对这个立场最终有多一致。',
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
    // A proposed position (a claim). It becomes the person's understanding only after `accept`.
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
              : 'proposed from a discussion',
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
        agreement: view
          .understandingOf(node.nodeId)
          ?.find((dimension) => dimension.id === AGREEMENT.id)?.level,
      })),
    }),
  },
]

export function discussionProfile(seed: SeedTopic = BLANK_TOPIC): SceneProfile {
  return { name: 'discussion', seed, scene: discussionScene, routes }
}
