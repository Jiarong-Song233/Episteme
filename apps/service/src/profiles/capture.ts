import { learnScene, type SessionScene } from '@episteme/application'
import { BLANK_TOPIC, type SceneProfile, type SeedTopic } from '../profile.js'
import { devScene } from './dev.js'
import { discussionScene } from './discussion.js'
import { CAPTURE_SCENES, noteRoutes } from './notes.js'

/** All capture clients share one graph owner and one copy of the common vocabulary. */
export const captureScene: SessionScene = {
  name: 'capture',
  packs: [...learnScene.packs, ...devScene.packs.slice(1), ...discussionScene.packs.slice(1)],
  distillationPolicy: learnScene.distillationPolicy,
  recordableDimensions: [
    ...learnScene.recordableDimensions,
    ...devScene.recordableDimensions,
    ...discussionScene.recordableDimensions,
  ],
}

export function captureProfile(seed: SeedTopic = BLANK_TOPIC): SceneProfile {
  return {
    name: 'capture',
    seed,
    scene: captureScene,
    routes: CAPTURE_SCENES.flatMap((scene) => noteRoutes(scene, `/${scene}/notes`)),
    proposingRoutes: CAPTURE_SCENES.map((scene) => `/${scene}/notes`),
  }
}
