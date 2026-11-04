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
