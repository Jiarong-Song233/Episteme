/**
 * What an agent's credential may do here besides read (ADR 0020): open a space, add material, draft a plan, and turn
 * words already on record into candidates that wait for the person. Nothing here deletes, archives or replaces, says
 * anything in the person's voice, or settles anything; those routes are not named, so they are the person's.
 */
export const WORKBENCH_PROPOSING_ROUTES = [
  '/spaces',
  '/materials',
  '/plans',
  '/candidates',
  '/candidates/turn',
  '/candidates/thread',
] as const

/**
 * What only the person may read: what is on their computer outside the graph, such as which agents it has, their
 * settings files, and the conversations those agents keep. An agent reads none of it, and none of it reaches a model.
 */
export const WORKBENCH_PRIVATE_ROUTES = [
  '/agents',
  '/agent-sessions',
  '/agent-sessions/read',
] as const
