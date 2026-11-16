import {
  defaultDistillationPolicy,
  defaultSessionPack,
  recordableDimensions,
  type SessionScene,
} from '@episteme/application'
import {
  asId,
  defineDomainPack,
  type DimensionId,
  type StateDimensionDefinition,
} from '@episteme/core'
import { BLANK_TOPIC, type SceneProfile, type SeedTopic } from '../profile.js'
import { noteRoutes } from './notes.js'

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

export function discussionProfile(seed: SeedTopic = BLANK_TOPIC): SceneProfile {
  return {
    name: 'discussion',
    seed,
    scene: discussionScene,
    routes: noteRoutes('discussion'),
    proposingRoutes: ['/notes'],
  }
}
