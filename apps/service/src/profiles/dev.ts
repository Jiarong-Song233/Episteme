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

export function devProfile(seed: SeedTopic = BLANK_TOPIC): SceneProfile {
  return {
    name: 'dev',
    seed,
    scene: devScene,
    routes: noteRoutes('dev'),
    proposingRoutes: ['/notes'],
  }
}
