import { learnScene, recordableDimensions, type SessionScene } from '@episteme/application'
import { asId, defineDomainPack, type DimensionId } from '@episteme/core'
import { BLANK_TOPIC, type SceneProfile } from '@episteme/service'
import { agentRoutes } from './agent-routes.js'
import { agentSessionRoutes } from './agent-sessions.js'
import type { AgentEnvironment, Agents } from './agents.js'
import { BUILT_IN_LIBRARY, type Library } from './blocks.js'
import { hostLearningTools } from './host-learning.js'
import type { ModelClient } from './model.js'
import type { ModelSettings } from './model-settings.js'
import { checkFiling } from './requests.js'
import { WORKBENCH_PRIVATE_ROUTES, WORKBENCH_PROPOSING_ROUTES } from './route-access.js'
import { workbenchRoutes } from './routes.js'
import { STANCE } from './understanding.js'

export const WORKBENCH_SCENE = 'workbench'

/**
 * Whether a person still holds something. Withdrawing is a state and not a deletion, so the event, its reason and what
 * they held before all stay in the history.
 */
const STANCE_DIMENSION = {
  id: asId<DimensionId>(STANCE),
  label: 'Stance',
  kind: 'ordinal',
  ordered: false,
  levels: ['held', 'withdrawn'],
} as const

/** The learning vocabulary and a stance. Its name stays `learn`, because a scene's records are kept by its name. */
export const workbenchScene: SessionScene = {
  ...learnScene,
  packs: [
    ...learnScene.packs,
    defineDomainPack('episteme-workbench', { stateDimensions: [STANCE_DIMENSION] }),
  ],
  recordableDimensions: [
    ...learnScene.recordableDimensions,
    ...recordableDimensions(
      [STANCE_DIMENSION],
      [
        {
          id: STANCE_DIMENSION.id,
          labelZh: '立场',
          levelLabelsZh: { held: '我持有', withdrawn: '已撤回' },
          description: 'Whether the person still holds this.',
          descriptionZh: '你现在还持有这条理解吗。',
        },
      ],
    ),
  ],
}

/**
 * The workbench as a scene of the service, on the learning vocabulary, starting from an empty graph.
 *
 * Make one per service start: its routes hold a store on that graph's connection.
 */
export function workbenchProfile(options: {
  readonly model: ModelClient
  readonly now?: () => number
  readonly library?: Library
  readonly modelSettings?: ModelSettings
  /** The agents of this computer, for the page that connects them. Without it there is no such page. */
  readonly agents?: Agents
  /** This computer, for reading the conversations its agents keep. Without it there is no such page. */
  readonly agentEnvironment?: AgentEnvironment
}): SceneProfile {
  return {
    name: WORKBENCH_SCENE,
    proposingRoutes: WORKBENCH_PROPOSING_ROUTES,
    privateRoutes: WORKBENCH_PRIVATE_ROUTES,
    checkFiling,
    seed: BLANK_TOPIC,
    scene: workbenchScene,
    routes: [
      ...workbenchRoutes(options),
      ...(options.agents === undefined ? [] : agentRoutes(options.agents)),
      ...(options.agentEnvironment === undefined
        ? []
        : agentSessionRoutes(options.agentEnvironment)),
    ],
    mcpTools: hostLearningTools({
      library: options.library ?? BUILT_IN_LIBRARY,
      now: options.now ?? Date.now,
    }),
  }
}
