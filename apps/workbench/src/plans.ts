import { randomUUID } from 'node:crypto'
import type { Library, Workflow } from './blocks.js'
import { refuse } from './requests.js'
import { coverage } from './tokens.js'

/** A plan and the rules for changing it. Nothing here calls a model or touches storage. */

export type StepStatus = 'pending' | 'active' | 'done' | 'skipped'

export interface Step {
  readonly id: string
  readonly block: string
  readonly focus: string
  /** The objective it is about (ADR 0019). Older steps have none, and map to one by their focus. */
  readonly objective?: string
  readonly minutes: number
  readonly status: StepStatus
  readonly note?: string
  /** Replies so far in a dialog. */
  readonly rounds: number
  /** Whether the step has shown what it opens with. A failed start leaves this false, so it can start again. */
  readonly entered: boolean
  readonly attempt?: string
  /** The material turned out to say nothing about this focus when the step was taught. */
  readonly unsupported?: boolean
}

export type PlanStatus = 'active' | 'paused' | 'done'

export interface Plan {
  readonly id: string
  readonly space: string
  readonly topic: string
  readonly minutes: number
  readonly workflow: string
  readonly thread: string
  /** Where the focuses came from: the model, the material's own outline when no model could say, or a host agent. */
  readonly origin: 'model' | 'outline' | 'host'
  readonly status: PlanStatus
  /** Goes up with every edit. Earlier versions are kept. */
  readonly version: number
  readonly steps: readonly Step[]
  readonly createdAt: number
  readonly updatedAt: number
}

const newStep = (block: string, focus: string, minutes: number, note?: string): Step => ({
  id: `st_${randomUUID()}`,
  block,
  focus,
  minutes,
  status: note === undefined ? 'pending' : 'skipped',
  rounds: 0,
  entered: false,
  ...(note === undefined ? {} : { note }),
})

/** How many focuses fit in the time. */
export function focusCount(workflow: Workflow, minutes: number): number {
  return Math.min(6, Math.max(1, Math.round(minutes / workflow.minutesPerFocus)))
}

/** Over this share of a focus's words in something the person confirmed, it counts as already understood. */
const UNDERSTOOD = 0.6

/** A workflow laid out over focuses, with its minutes shared out by weight and adding up to the time asked for. */
export function layOut(
  library: Library,
  workflow: Workflow,
  input: {
    readonly topic: string
    readonly focuses: readonly string[]
    readonly minutes: number
    readonly understood: readonly string[]
  },
): readonly Step[] {
  const weightOf = (id: string): number =>
    library.blocks.find((block) => block.id === id)?.weight ?? 1
  const known = (focus: string): boolean =>
    workflow.skipsUnderstood &&
    input.understood.some((label) => coverage(focus, label) >= UNDERSTOOD)
  const planned = [
    ...workflow.opening.map((block) => ({ block, focus: input.topic, skip: false })),
    ...input.focuses.flatMap((focus) =>
      workflow.perFocus.map((block) => ({ block, focus, skip: known(focus) })),
    ),
    ...workflow.closing.map((block) => ({ block, focus: input.topic, skip: false })),
  ]
  const counted = planned.filter((step) => !step.skip)
  const total = counted.reduce((sum, step) => sum + weightOf(step.block), 0)
  let assigned = 0
  return planned.map((step, index) => {
    if (step.skip) return newStep(step.block, step.focus, 0, '你已确认过相关的理解，所以跳过。')
    const last = index === planned.findLastIndex((candidate) => !candidate.skip)
    const minutes = last
      ? Math.max(1, input.minutes - assigned)
      : Math.max(1, Math.round((input.minutes * weightOf(step.block)) / total))
    assigned += minutes
    return newStep(step.block, step.focus, minutes)
  })
}

/**
 * The plan's steps after the person's edit. What has already happened stays: a step that is done or under way
 * cannot be removed or moved, only what lies ahead can change.
 */
export function editedSteps(
  plan: Plan,
  edits: readonly unknown[],
  library: Library,
): readonly Step[] {
  if (edits.length === 0) refuse('invalid_step', '计划至少要有一步。')
  const blocks = new Set(library.blocks.map((block) => block.id))
  const held = new Map(plan.steps.map((step) => [step.id, step]))
  const steps = edits.map((edit): Step => {
    const { id, block, focus, minutes, restore } = (edit ?? {}) as Record<string, unknown>
    if (typeof block !== 'string' || !blocks.has(block)) {
      refuse('unknown_block', `没有叫“${String(block)}”的学习活动。`)
    }
    if (typeof focus !== 'string' || focus.trim() === '' || focus.length > 200) {
      refuse('invalid_step', '每一步都要有内容，且不超过 200 个字。')
    }
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > 600) {
      refuse('invalid_step', '时间要在 0 到 600 分钟之间。')
    }
    const kept = typeof id === 'string' ? held.get(id) : undefined
    if (id !== undefined && kept === undefined) {
      refuse('unknown_step', '计划里没有这一步。请刷新后再改。')
    }
    if (kept === undefined) return newStep(block, focus.trim(), minutes)
    if (kept.status === 'done' || kept.status === 'active') {
      if (block !== kept.block || focus !== kept.focus) {
        refuse('step_locked', '已经开始或完成的步骤不能修改。')
      }
      return kept
    }
    const { note: _note, ...rest } = kept
    const restored = kept.status === 'skipped' && restore === true
    return {
      ...(restored ? rest : kept),
      block,
      focus: focus.trim(),
      minutes,
      status: restored ? 'pending' : kept.status,
    }
  })
  const lockedBefore = plan.steps
    .filter((step) => step.status === 'done' || step.status === 'active')
    .map((step) => step.id)
  const lockedAfter = steps
    .filter((step) => step.status === 'done' || step.status === 'active')
    .map((step) => step.id)
  if (lockedBefore.join() !== lockedAfter.join()) {
    refuse('step_locked', '已经开始或完成的步骤不能删除或调整顺序。')
  }
  const firstOpen = steps.findIndex((step) => step.status === 'pending')
  const lastLocked = steps.findLastIndex(
    (step) => step.status === 'done' || step.status === 'active',
  )
  if (firstOpen !== -1 && firstOpen < lastLocked) {
    refuse('step_locked', '不能把新步骤放到已经开始或完成的步骤前面。')
  }
  return steps
}

/** A step changed, the rest as they were. */
export function withStep(plan: Plan, id: string, change: Partial<Step>, at: number): Plan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.id === id ? { ...step, ...change } : step)),
    updatedAt: at,
  }
}

export const currentStep = (plan: Plan): Step | undefined =>
  plan.steps.find((step) => step.status === 'active')

export const nextStep = (plan: Plan): Step | undefined =>
  plan.steps.find((step) => step.status === 'pending')
