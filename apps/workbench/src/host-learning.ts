import { createHash, randomUUID } from 'node:crypto'
import type { SceneView } from '@episteme/application'
import type { SceneTool, SceneToolAnswer, SceneToolContext } from '@episteme/service'
import type { Library } from './blocks.js'
import {
  digestOf,
  EVIDENCE_PREFIX,
  OBJECTIVE_PREFIX,
  objectiveIdOf,
  objectivesOf,
  unlinkedIn,
  type EvidenceSource,
  type LearningEvidence,
  type Objective,
  type Verdict,
} from './evidence.js'
import { PLAN_PREFIX } from './learning.js'
import { currentStep, nextStep, type Plan, type Step } from './plans.js'
import { openSpaceOf, refuse, scopeOf, SPACE_PREFIX, text, type Space } from './requests.js'

/**
 * Learning run by a host agent over MCP (ADR 0019). The host chooses what to teach and how, and these tools hold the
 * record to its rules. They receive only a `SceneView`, so none of them can decide anything, and they never call a
 * model: whatever teaching happens, happens in the host.
 */

const SUBMISSION_PREFIX = 'submission/'
const MAX_WORDS = 4000

interface Args {
  readonly [field: string]: unknown
}

interface Submission {
  readonly fingerprint: string
  readonly structured: Readonly<Record<string, unknown>>
}

const COMMON = {
  submission: {
    type: 'string',
    description: 'An id you make up for this one write. Sending it again repeats nothing.',
  },
} as const

const PLAN_AT = {
  plan: { type: 'string' },
  planVersion: {
    type: 'integer',
    description: 'The version you last read. A plan that has moved on since is refused.',
  },
} as const

const NEW_STEP = {
  type: 'object',
  properties: {
    activity: { type: 'string', description: 'An activity id from learn_context.' },
    objective: { type: 'string', description: 'An objective id from learn_context, to reuse it.' },
    label: {
      type: 'string',
      description:
        'What is to be learned, when no objective exists yet. Name the thing and not the activity: steps that explain and then retell one point share one objective, and the same words give the same objective.',
    },
    minutes: { type: 'integer', minimum: 0, maximum: 600 },
  },
  required: ['activity'],
  additionalProperties: false,
} as const

function optionalText(args: Args, field: string, max = MAX_WORDS): string | undefined {
  return args[field] === undefined ? undefined : text(args, field, max).trim()
}

function planOf(view: SceneView, id: string): Plan {
  const record = view.records.get(`${PLAN_PREFIX}${id}`)
  if (record === undefined) refuse('unknown_plan', `no plan "${id}"`)
  return record.value as Plan
}

/**
 * A plan the host runs, at the version the caller read. Tying a suggestion to an objective records no step, so `after`
 * lets it through once the plan has finished.
 */
function planToWrite(view: SceneView, args: Args, after = false): Plan {
  const plan = planOf(view, text(args, 'plan'))
  if (plan.origin !== 'host') refuse('not_host_plan', 'this plan is run from the web page')
  if (plan.status === 'done' && !after) refuse('plan_done', 'this plan has finished')
  if (plan.status === 'paused') refuse('plan_paused', 'the person paused this plan')
  openSpaceOf(view, plan.space)
  if (args['planVersion'] !== plan.version) {
    refuse(
      'version_conflict',
      `the plan is at version ${plan.version}, not ${String(args['planVersion'])}; read it again with learn_context`,
    )
  }
  return plan
}

/** Whether what the host is doing about this objective is on record: before any answer, and after one that fell short. */
function activityChosen(view: SceneView, objective: string): boolean {
  const earlier = view.records
    .list(EVIDENCE_PREFIX)
    .map((record) => record.value as LearningEvidence)
    .filter((evidence) => evidence.objective === objective)
    .sort((left, right) => left.seq - right.seq)
  const fellShort = earlier.findLastIndex(
    (evidence) => evidence.kind === 'attempt' && evidence.assessment?.verdict !== 'supports',
  )
  if (fellShort === -1 && earlier.some((evidence) => evidence.kind === 'attempt')) return true
  return earlier.slice(fellShort + 1).some((evidence) => evidence.kind === 'move')
}

/** Says so when a suggestion would not reach an objective, on the answers a host reads as it goes. */
function noticingUnlinked(
  view: SceneView,
  space: string,
  answer: SceneToolAnswer,
): SceneToolAnswer {
  const unlinked = unlinkedIn(view, space)
  if (unlinked.length === 0) return answer
  return {
    text: `${answer.text} ${unlinked.length} suggestion(s) in this space are tied to no objective; if one is about an objective, link it with learn_observe kind "candidate", or the person's confirmation will not reach that objective.`,
    structured: { ...answer.structured, unlinked },
  }
}

export function hostLearningTools(options: {
  readonly library: Library
  readonly now: () => number
}): readonly SceneTool[] {
  const { library, now } = options
  const activityIds = new Set(library.blocks.map((block) => block.id))

  // One write at a time, so a version check and the write it guards cannot be overtaken by another call.
  let last: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const mine = last.then(run, run)
    last = mine.catch(() => undefined)
    return mine
  }

  /** A write that is safe to send twice: the same submission answers the same, and other content under it is refused. */
  const once =
    (
      tool: string,
      write: (
        args: Args,
        context: SceneToolContext,
        submission: string,
      ) => Promise<SceneToolAnswer>,
    ) =>
    (args: Args, context: SceneToolContext): Promise<SceneToolAnswer> =>
      inTurn(async () => {
        const submission = text(args, 'submission', 200).trim()
        const fingerprint = createHash('sha256')
          .update(JSON.stringify([tool, args]))
          .digest('hex')
        const key = `${SUBMISSION_PREFIX}${submission}`
        const earlier = context.view.records.get(key)?.value as Submission | undefined
        if (earlier !== undefined) {
          if (earlier.fingerprint !== fingerprint) {
            refuse('submission_conflict', `submission "${submission}" was used for something else`)
          }
          return {
            text: 'Already recorded; nothing changed.',
            structured: { ...earlier.structured, replayed: true },
          }
        }
        const answer = await write(args, context, submission)
        const kept: Submission = { fingerprint, structured: answer.structured }
        await context.view.records.put(key, kept)
        return answer
      })

  const savePlan = async (view: SceneView, plan: Plan): Promise<Plan> => {
    await view.records.put(`${PLAN_PREFIX}${plan.id}`, plan)
    return plan
  }

  /** The objective named by id, or the one these words make, written the first time it is needed. */
  const objectiveFor = async (
    view: SceneView,
    space: string,
    agent: string,
    named: { readonly objective?: unknown; readonly label?: unknown },
  ): Promise<Objective> => {
    if (typeof named.objective === 'string') {
      const held = view.records.get(`${OBJECTIVE_PREFIX}${named.objective}`)?.value as
        | Objective
        | undefined
      if (held === undefined || held.space !== space) {
        refuse(
          'objective_outside_plan',
          `no objective "${named.objective}" in this space; objective takes an id from learn_context, and a new objective is named with label`,
        )
      }
      return held
    }
    if (typeof named.label !== 'string' || named.label.trim() === '' || named.label.length > 200) {
      refuse('invalid_step', 'a step needs an objective id, or a label of at most 200 characters')
    }
    const id = objectiveIdOf(space, named.label)
    const held = view.records.get(`${OBJECTIVE_PREFIX}${id}`)?.value as Objective | undefined
    if (held !== undefined) return held
    const made: Objective = {
      id,
      space,
      label: named.label.trim(),
      createdAt: now(),
      createdBy: agent,
    }
    await view.records.put(`${OBJECTIVE_PREFIX}${id}`, made)
    return made
  }

  const newSteps = async (
    view: SceneView,
    space: string,
    agent: string,
    raw: unknown,
  ): Promise<readonly Step[]> => {
    if (!Array.isArray(raw)) refuse('invalid_step', '"steps" must be a list')
    const steps: Step[] = []
    for (const entry of raw) {
      const { activity, minutes, objective, label } = (entry ?? {}) as Args
      if (typeof activity !== 'string' || !activityIds.has(activity)) {
        refuse('unknown_block', `no activity "${String(activity)}"; learn_context lists them`)
      }
      const time = minutes ?? 5
      if (typeof time !== 'number' || !Number.isInteger(time) || time < 0 || time > 600) {
        refuse('invalid_step', 'minutes must be between 0 and 600')
      }
      const held = await objectiveFor(view, space, agent, { objective, label })
      steps.push({
        id: `st_${randomUUID()}`,
        block: activity,
        focus: held.label,
        objective: held.id,
        minutes: time,
        status: 'pending',
        rounds: 0,
        entered: false,
      })
    }
    return steps
  }

  const showPlan = (plan: Plan) => ({
    id: plan.id,
    topic: plan.topic,
    status: plan.status,
    version: plan.version,
    thread: plan.thread,
    origin: plan.origin,
    current: currentStep(plan)?.id,
    next: nextStep(plan)?.id,
    steps: plan.steps.map((step) => ({
      id: step.id,
      activity: step.block,
      label: step.focus,
      objective: step.objective ?? objectiveIdOf(plan.space, step.focus),
      minutes: step.minutes,
      status: step.status,
      ...(step.note === undefined ? {} : { note: step.note }),
    })),
  })

  const sourceFrom = (view: SceneView, space: string, args: Args): EvidenceSource => {
    const thread = text(args, 'thread')
    const shown = view.threadView(thread)
    if (shown === undefined || shown.thread.scope !== scopeOf(space)) {
      refuse(
        'thread_outside_space',
        `that thread is not one of yours in this space; open one with scope ${scopeOf(space)}`,
      )
    }
    const turn = shown.turns.find((each) => each.id === args['turn'])
    if (turn === undefined || turn.speaker !== 'learner') {
      refuse('quote_not_found', 'the source must be a learner turn of that thread')
    }
    const quote = text(args, 'quote', MAX_WORDS)
    const start = turn.text.indexOf(quote)
    if (start === -1) refuse('quote_not_found', 'those words are not in that learner turn')
    return {
      thread,
      turn: turn.id,
      start,
      end: start + quote.length,
      sha256: digestOf(quote),
    }
  }

  const suggestionIn = (view: SceneView, space: string, args: Args): string => {
    const suggestion = text(args, 'suggestion')
    const scope = scopeOf(space)
    const waiting = view
      .pendingSuggestions()
      .find((candidate) => candidate.id === suggestion && candidate.scope === scope)
    if (
      waiting !== undefined &&
      waiting.proposal.kind !== 'claim' &&
      waiting.proposal.kind !== 'node'
    ) {
      refuse('invalid_evidence', 'only a claim can stand for what an objective is about')
    }
    const accepted = view
      .listNodes()
      .some((node) => node.fromSuggestion === suggestion && node.tags.includes(`scope:${scope}`))
    if (waiting === undefined && !accepted) {
      refuse('unknown_suggestion', 'that suggestion is not one of yours in this space')
    }
    return suggestion
  }

  return [
    {
      name: 'learn_context',
      title: 'Read where a person’s learning stands',
      description:
        'Without a space: their learning spaces. With one: the activities you can choose from, each objective with what the evidence shows, the plans, and the suggestions tied to no objective (`unlinked`). `gap` is what attempts showed, and `confirmation` is whether the person holds it; neither says they have mastered anything. Call this first in a new session.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { space: { type: 'string' } },
        additionalProperties: false,
      },
      handle: (args, { view }) => {
        const asked = optionalText(args, 'space')
        if (asked === undefined) {
          const spaces = view.records.list(SPACE_PREFIX).map((record) => record.value as Space)
          return {
            text: `${spaces.length} space(s).`,
            structured: {
              spaces: spaces.map(({ id, name, archived }) => ({ id, name, archived })),
            },
          }
        }
        const space = openSpaceOf(view, asked)
        const objectives = objectivesOf(view, space.id, { withWords: true })
        const plans = view.records
          .list(PLAN_PREFIX)
          .map((record) => record.value as Plan)
          .filter((plan) => plan.space === space.id)
          .sort((left, right) => right.updatedAt - left.updatedAt)
        return {
          text: `${space.name}: ${objectives.length} objective(s), ${objectives.filter((each) => each.gap !== undefined && each.gap.status !== 'supported').length} with an unresolved gap.`,
          structured: {
            space: { id: space.id, name: space.name, scope: scopeOf(space.id) },
            activities: library.blocks.map(({ id, title, interaction, instruction, opening }) => ({
              id,
              title,
              interaction,
              ...(instruction === undefined ? {} : { instruction }),
              ...(opening === undefined ? {} : { opening }),
            })),
            objectives,
            plans: plans.map(showPlan),
            unlinked: unlinkedIn(view, space.id),
          },
        }
      },
    },
    {
      name: 'learn_space_open',
      title: 'Open a learning space',
      description:
        'Finds the person’s open space with this name, or starts one. Use the returned scope for thread_open, propose and distill.',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: { ...COMMON, name: { type: 'string', maxLength: 200 } },
        required: ['submission', 'name'],
        additionalProperties: false,
      },
      handle: once('learn_space_open', async (args, { view }) => {
        const name = text(args, 'name', 200).trim()
        const held = view.records
          .list(SPACE_PREFIX)
          .map((record) => record.value as Space)
          .find((space) => space.name === name && !space.archived)
        const space: Space = held ?? {
          id: `sp_${randomUUID()}`,
          name,
          archived: false,
          createdAt: now(),
        }
        if (held === undefined) await view.records.put(`${SPACE_PREFIX}${space.id}`, space)
        return {
          text: `Space ${space.name}, scope ${scopeOf(space.id)}.`,
          structured: { space: { id: space.id, name: space.name, scope: scopeOf(space.id) } },
        }
      }),
    },
    {
      name: 'learn_plan_start',
      title: 'Start a plan you will run',
      description:
        'Lays out the steps you chose, on a thread you opened with this space’s scope. The objectives are written if they are new. This records the plan; teaching is yours.',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...COMMON,
          space: { type: 'string' },
          topic: { type: 'string', maxLength: 200 },
          thread: { type: 'string' },
          steps: { type: 'array', minItems: 1, maxItems: 30, items: NEW_STEP },
        },
        required: ['submission', 'space', 'topic', 'thread', 'steps'],
        additionalProperties: false,
      },
      handle: once('learn_plan_start', async (args, { view, agent }) => {
        const space = openSpaceOf(view, text(args, 'space'))
        const thread = text(args, 'thread')
        if (view.threadView(thread)?.thread.scope !== scopeOf(space.id)) {
          refuse(
            'thread_outside_space',
            `that thread is not one of yours in this space; open one with scope ${scopeOf(space.id)}`,
          )
        }
        const steps = await newSteps(view, space.id, agent, args['steps'])
        if (steps.length === 0) refuse('invalid_step', 'a plan needs at least one step')
        const at = now()
        const plan = await savePlan(view, {
          id: `pl_${randomUUID()}`,
          space: space.id,
          topic: text(args, 'topic', 200).trim(),
          minutes: steps.reduce((sum, step) => sum + step.minutes, 0),
          workflow: 'host',
          thread,
          origin: 'host',
          status: 'active',
          version: 1,
          steps,
          createdAt: at,
          updatedAt: at,
        })
        return { text: `Plan ${plan.id}, version 1.`, structured: { plan: showPlan(plan) } }
      }),
    },
    {
      name: 'learn_plan_change',
      title: 'Change what lies ahead in a plan',
      description:
        'Adds steps right after what is under way, or at the end, and skips steps not yet done. What has happened stays as it was.',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...COMMON,
          ...PLAN_AT,
          add: { type: 'array', maxItems: 30, items: NEW_STEP },
          position: { type: 'string', enum: ['next', 'last'] },
          skip: {
            type: 'array',
            maxItems: 30,
            items: {
              type: 'object',
              properties: { step: { type: 'string' }, reason: { type: 'string' } },
              required: ['step', 'reason'],
              additionalProperties: false,
            },
          },
        },
        required: ['submission', 'plan', 'planVersion'],
        additionalProperties: false,
      },
      handle: once('learn_plan_change', async (args, { view, agent }) => {
        const plan = planToWrite(view, args)
        const added = await newSteps(view, plan.space, agent, args['add'] ?? [])
        const skips = (args['skip'] ?? []) as readonly { step?: unknown; reason?: unknown }[]
        const skipped = new Map<string, string>()
        for (const { step, reason } of skips) {
          const held = plan.steps.find((each) => each.id === step)
          if (held === undefined) refuse('unknown_step', `no step "${String(step)}" in this plan`)
          if (held.status !== 'pending') {
            refuse(
              'invalid_transition',
              `step ${held.id} is ${held.status}; only one ahead can be skipped`,
            )
          }
          if (typeof reason !== 'string' || reason.trim() === '') {
            refuse('invalid_request', 'skipping a step needs a reason')
          }
          skipped.set(held.id, reason.trim())
        }
        if (added.length === 0 && skipped.size === 0) {
          refuse('invalid_request', 'nothing to change')
        }
        const steps = plan.steps.map((step): Step => {
          const reason = skipped.get(step.id)
          return reason === undefined ? step : { ...step, status: 'skipped', note: reason }
        })
        const at =
          args['position'] === 'next'
            ? steps.findLastIndex((step) => step.status === 'active' || step.status === 'done') + 1
            : steps.length
        const changed = await savePlan(view, {
          ...plan,
          steps: [...steps.slice(0, at), ...added, ...steps.slice(at)],
          version: plan.version + 1,
          updatedAt: now(),
        })
        return {
          text: `Plan ${plan.id}, version ${changed.version}.`,
          structured: { plan: showPlan(changed) },
        }
      }),
    },
    {
      name: 'learn_step',
      title: 'Move a plan’s step',
      description:
        '`enter` opens the next step. `complete` closes the open one and needs an attempt or statement recorded on it. `skip` closes it without any, and says why. Saying a step is done says nothing about what the person understands.',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...COMMON,
          ...PLAN_AT,
          step: { type: 'string' },
          action: { type: 'string', enum: ['enter', 'complete', 'skip'] },
          reason: { type: 'string', description: 'Why, for a skip.' },
        },
        required: ['submission', 'plan', 'planVersion', 'step', 'action'],
        additionalProperties: false,
      },
      handle: once('learn_step', async (args, { view }) => {
        const plan = planToWrite(view, args)
        const id = text(args, 'step')
        const step = plan.steps.find((each) => each.id === id)
        if (step === undefined) refuse('unknown_step', `no step "${id}" in this plan`)
        const action = text(args, 'action')
        let change: Partial<Step>
        if (action === 'enter') {
          if (currentStep(plan) !== undefined) {
            refuse('invalid_transition', 'another step is still open; complete or skip it first')
          }
          if (nextStep(plan)?.id !== id) {
            refuse('invalid_transition', `step ${id} is ${step.status}, and not the next one`)
          }
          change = { status: 'active', entered: true }
        } else if (action === 'complete') {
          if (step.status !== 'active') {
            refuse('invalid_transition', `step ${id} is ${step.status}, not open`)
          }
          const shown = view.records
            .list(EVIDENCE_PREFIX)
            .map((record) => record.value as LearningEvidence)
            .some(
              (evidence) =>
                evidence.step === id &&
                (evidence.kind === 'attempt' || evidence.kind === 'statement'),
            )
          if (!shown) {
            refuse(
              'no_evidence',
              'nothing the learner did is recorded on this step; skip it instead',
            )
          }
          change = { status: 'done' }
        } else if (action === 'skip') {
          if (step.status !== 'active' && step.status !== 'pending') {
            refuse('invalid_transition', `step ${id} is ${step.status}`)
          }
          change = { status: 'skipped', note: text(args, 'reason', 1000).trim() }
        } else {
          return refuse('invalid_request', `unknown action "${action}"`)
        }
        const steps = plan.steps.map((each) => (each.id === id ? { ...each, ...change } : each))
        const finished = steps.every((each) => each.status === 'done' || each.status === 'skipped')
        const moved = await savePlan(view, {
          ...plan,
          steps,
          status: finished ? 'done' : plan.status,
          version: plan.version + 1,
          updatedAt: now(),
        })
        return noticingUnlinked(view, plan.space, {
          text: `Step ${id} is ${change.status}; plan version ${moved.version}.`,
          structured: { plan: showPlan(moved) },
        })
      }),
    },
    {
      name: 'learn_observe',
      title: 'Record what happened',
      description:
        'One piece of evidence on an objective. `move` is which activity you chose and why (activity, reason); an attempt is refused until one is recorded, the first time and after an answer that was not judged to support. `attempt` and `statement` quote a learner turn you relayed with thread_append (thread, turn, quote); an attempt may carry your verdict, reason and diagnosis, recorded as your reading. `feedback` is what you told them and why (reason). `candidate` ties a suggestion from propose or distill to this objective (suggestion): without it, the person confirming that suggestion does not reach the objective. This never changes what the person understands.',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...COMMON,
          ...PLAN_AT,
          objective: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['attempt', 'statement', 'feedback', 'move', 'candidate'],
          },
          step: { type: 'string' },
          thread: { type: 'string' },
          turn: { type: 'string' },
          quote: { type: 'string' },
          verdict: { type: 'string', enum: ['supports', 'partial', 'contradicts', 'unclear'] },
          reason: { type: 'string' },
          diagnosis: { type: 'string' },
          activity: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['submission', 'plan', 'planVersion', 'objective', 'kind'],
        additionalProperties: false,
      },
      handle: once('learn_observe', async (args, { view, agent }, submission) => {
        const plan = planToWrite(view, args, args['kind'] === 'candidate')
        const objective = text(args, 'objective')
        const held = view.records.get(`${OBJECTIVE_PREFIX}${objective}`)?.value as
          | Objective
          | undefined
        if (held === undefined || held.space !== plan.space) {
          refuse('objective_outside_plan', `no objective "${objective}" in this plan's space`)
        }
        const named = optionalText(args, 'step')
        // Left out, it is the step under way when that step is about this objective: `complete` reads evidence by step.
        const open = currentStep(plan)
        const stepId = named ?? (open?.objective === objective ? open.id : undefined)
        if (named !== undefined) {
          const step = plan.steps.find((each) => each.id === named)
          if (step === undefined) refuse('unknown_step', `no step "${named}" in this plan`)
          if (step.objective !== objective) {
            refuse('objective_outside_plan', `step ${named} is about another objective`)
          }
        }
        const kind = text(args, 'kind') as LearningEvidence['kind']
        const reason = optionalText(args, 'reason')
        const verdict = args['verdict'] as Verdict | undefined
        if (verdict !== undefined && kind !== 'attempt') {
          refuse('invalid_evidence', 'only an attempt carries a verdict')
        }
        if (verdict !== undefined && reason === undefined) {
          refuse('invalid_evidence', 'a verdict needs its reason')
        }
        let details: Partial<LearningEvidence>
        const diagnosis = optionalText(args, 'diagnosis')
        switch (kind) {
          case 'attempt':
          case 'statement': {
            const source = sourceFrom(view, plan.space, args)
            if (kind === 'attempt' && !activityChosen(view, objective)) {
              refuse(
                'no_move',
                'record which activity you chose for this objective and why (kind "move") first',
              )
            }
            details = {
              source,
              ...(verdict === undefined || reason === undefined
                ? {}
                : {
                    assessment: {
                      verdict,
                      method: 'agent' as const,
                      reason,
                      ...(diagnosis === undefined ? {} : { diagnosis }),
                    },
                  }),
            }
            break
          }
          case 'feedback':
            if (reason === undefined) refuse('invalid_evidence', 'feedback needs a reason')
            details = { assessment: { verdict: 'unclear', method: 'agent', reason } }
            break
          case 'move': {
            const activity = text(args, 'activity')
            if (!activityIds.has(activity)) refuse('unknown_block', `no activity "${activity}"`)
            if (reason === undefined) refuse('invalid_evidence', 'a move needs its reason')
            details = { move: { activity, reason } }
            break
          }
          case 'candidate':
            details = { suggestion: suggestionIn(view, plan.space, args) }
            break
          default:
            return refuse('invalid_evidence', `unknown kind "${String(kind)}"`)
        }
        const evidence: LearningEvidence = {
          id: submission,
          seq: view.records.list(EVIDENCE_PREFIX).length + 1,
          at: now(),
          recordedBy: agent,
          space: plan.space,
          plan: plan.id,
          ...(stepId === undefined ? {} : { step: stepId }),
          objective,
          kind,
          ...details,
        }
        await view.records.put(`${EVIDENCE_PREFIX}${evidence.id}`, evidence)
        return noticingUnlinked(view, plan.space, {
          text: `Recorded ${kind}. It changes nothing the person holds.`,
          structured: { evidence: { id: evidence.id, kind, objective } },
        })
      }),
    },
  ]
}
