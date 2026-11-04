import { learnScene } from '@episteme/application'
import { BLANK_TOPIC, type SceneProfile } from '@episteme/service'
import type { ModelClient } from './model.js'
import { WORKBENCH_PROPOSING_ROUTES } from './route-access.js'
import { workbenchRoutes } from './routes.js'

export const WORKBENCH_SCENE = 'workbench'

/**
 * The workbench as a scene of the service, on the learning vocabulary, starting from an empty graph.
 *
 * Make one per service start: its routes hold a store on that graph's connection.
 */
export function workbenchProfile(options: {
  readonly model: ModelClient
  readonly now?: () => number
}): SceneProfile {
  return {
    name: WORKBENCH_SCENE,
    proposingRoutes: WORKBENCH_PROPOSING_ROUTES,
    seed: BLANK_TOPIC,
    scene: learnScene,
    routes: workbenchRoutes(options),
  }
}
