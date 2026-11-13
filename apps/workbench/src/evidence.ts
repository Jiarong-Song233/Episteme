import { createHash } from 'node:crypto'
import type { SceneView } from '@episteme/application'
import type { Plan } from './plans.js'
import type { Attempt } from './practice.js'
import { scopeOf } from './requests.js'
import { heldNodes, wordsByTurn, type WordsBy } from './understanding.js'

/**
 * What a learner did, and how it reads across sessions (ADR 0019).
 *
 * Evidence is a record of what was relayed and how an agent or a check judged it. It is never state: what the person
 * holds is what they confirmed, and the two are read apart. Nothing here calls a model or writes.
 */

export const OBJECTIVE_PREFIX = 'objective/'
export const EVIDENCE_PREFIX = 'evidence/'

export interface Objective {
  readonly id: string
  readonly space: string
  readonly label: string
  readonly createdAt: number
  readonly createdBy: string
}

export type Verdict = 'supports' | 'partial' | 'contradicts' | 'unclear'

export interface EvidenceSource {
  readonly thread: string
  readonly turn: string
  readonly start: number
  readonly end: number
  readonly sha256: string
}

export interface LearningEvidence {
  readonly id: string
  /** Its place among this person's evidence, so two written in one millisecond keep their order. */
  readonly seq: number
  readonly at: number
  readonly recordedBy: string
  readonly space: string
  readonly plan: string
  readonly step?: string
  readonly objective: string
  readonly kind: 'attempt' | 'statement' | 'feedback' | 'move' | 'candidate'
  /** Where the words are. They stay in the thread, so deleting a turn leaves no copy here. */
  readonly source?: EvidenceSource
  readonly assessment?: {
    readonly verdict: Verdict
    /** `agent`: a host agent's reading. `model`: the service's model. `mechanical`: a check of a choice or blank. */
    readonly method: 'agent' | 'model' | 'mechanical'
    readonly reason: string
    readonly diagnosis?: string
  }
  readonly move?: { readonly activity: string; readonly reason: string }
  readonly suggestion?: string
}

/** Not understanding, and with no state meaning it was overcome: only what the attempts since it show. */
export interface Gap {
  readonly status: 'open' | 'retried' | 'supported'
  readonly openedAt: number
  /** Attempts since it opened. */
  readonly retries: number
  readonly diagnosis?: string
  /** The attempt that opened it or last went wrong. */
  readonly wrong: string
  /** Who judged the attempt that supports it, when it is `supported`. */
  readonly supportedBy?: { readonly method: string; readonly recordedBy: string }
}

export type Confirmation = 'none' | 'pending' | 'delegated' | 'person'

export interface ObjectiveReading {
  readonly id: string
  readonly label: string
  readonly attempts: number
  readonly gap?: Gap
  readonly confirmation: Confirmation
  readonly candidates: readonly {
    readonly suggestion: string
    readonly label: string
    readonly status: 'pending' | 'person' | 'delegated' | 'dropped'
    /** The node it is now, after any revisions, while the person holds it. */
    readonly node?: string
  }[]
  readonly moves: readonly {
    readonly activity: string
    readonly reason: string
    readonly at: number
    readonly plan: string
  }[]
  readonly corrections: readonly { readonly text: string; readonly at: number }[]
  /** The words of the last wrong attempt, only when asked for. `null` when they are no longer there. */
  readonly wrongWords?: string | null
}

const collapsed = (text: string): string =>
  text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

/** The same words, in any session or plan, are the same objective. */
export function objectiveIdOf(space: string, label: string): string {
  const digest = createHash('sha256')
    .update(`${space}\n${collapsed(label)}`)
    .digest('hex')
  return `ob_${digest.slice(0, 16)}`
}

export const digestOf = (words: string): string =>
  createHash('sha256').update(words, 'utf8').digest('hex')

function inOrder(evidence: readonly LearningEvidence[]): readonly LearningEvidence[] {
  return [...evidence].sort((left, right) => left.at - right.at || left.seq - right.seq)
}

/** What the attempts on one objective show, in order. A later wrong attempt reopens it, whatever came between. */
export function gapOf(evidence: readonly LearningEvidence[]): Gap | undefined {
  let gap: Gap | undefined
  for (const attempt of inOrder(evidence)) {
    if (attempt.kind !== 'attempt') continue
    const assessment = attempt.assessment
    const wrong = assessment?.verdict === 'partial' || assessment?.verdict === 'contradicts'
    if (wrong) {
      gap = {
        status: 'open',
        openedAt: gap?.openedAt ?? attempt.at,
        retries: gap === undefined ? 0 : gap.retries + 1,
        wrong: attempt.id,
        ...(assessment.diagnosis === undefined ? {} : { diagnosis: assessment.diagnosis }),
      }
    } else if (gap !== undefined) {
      const { supportedBy: _earlier, ...kept } = gap
      gap =
        assessment?.verdict === 'supports'
          ? {
              ...kept,
              status: 'supported',
              retries: gap.retries + 1,
              supportedBy: { method: assessment.method, recordedBy: attempt.recordedBy },
            }
          : { ...kept, status: 'retried', retries: gap.retries + 1 }
    }
  }
  return gap
}

/** An answer on a page plan, read as evidence: a check of a choice, or the service's model on a free answer. */
function fromPractice(attempt: Attempt, space: string, seq: number): LearningEvidence | undefined {
  if (attempt.answeredAt === undefined) return undefined
  const base = {
    id: attempt.id,
    seq,
    at: attempt.answeredAt,
    recordedBy: 'workbench',
    space,
    plan: attempt.plan,
    step: attempt.step,
    objective: objectiveIdOf(space, attempt.focus),
    kind: 'attempt',
  } as const
  if (attempt.correct !== undefined) {
    return {
      ...base,
      assessment: {
        verdict: attempt.correct ? 'supports' : 'contradicts',
        method: 'mechanical',
        reason: attempt.question.prompt,
      },
    }
  }
  const verdicts = { correct: 'supports', partial: 'partial', wrong: 'contradicts' } as const
  return attempt.estimate === undefined
    ? base
    : {
        ...base,
        assessment: {
          verdict: verdicts[attempt.estimate],
          method: 'model',
          reason: attempt.question.prompt,
        },
      }
}

/** The evidence of one space, the page's answers included, oldest first. */
export function evidenceOf(view: SceneView, space: string): readonly LearningEvidence[] {
  const recorded = view.records
    .list(EVIDENCE_PREFIX)
    .map((record) => record.value as LearningEvidence)
    .filter((evidence) => evidence.space === space)
  const plans = new Set(
    view.records
      .list('plan/')
      .map((record) => record.value as Plan)
      .filter((plan) => plan.space === space)
      .map((plan) => plan.id),
  )
  const answered = view.records
    .list('attempt/')
    .map((record) => record.value as Attempt)
    .filter((attempt) => plans.has(attempt.plan))
    .flatMap((attempt, index) => fromPractice(attempt, space, index) ?? [])
  return inOrder([...recorded, ...answered])
}

/** The words a source points at, or `null` when they are not there any more or are not the same. */
export function wordsOf(view: SceneView, source: EvidenceSource): string | null {
  const turn = view.threadView(source.thread)?.turns.find((each) => each.id === source.turn)
  const words = turn?.text.slice(source.start, source.end)
  return words === undefined || digestOf(words) !== source.sha256 ? null : words
}

const STATUS_RANK = { dropped: 0, pending: 1, delegated: 2, person: 3 } as const

/** How the person came to hold each candidate. A delegated acceptance is never read as the person's own. */
function candidatesOf(
  view: SceneView,
  space: string,
  suggestions: readonly string[],
): ObjectiveReading['candidates'] {
  const scope = scopeOf(space)
  const held = heldNodes(view, space)
  const pending = view.pendingSuggestions().filter((suggestion) => suggestion.scope === scope)
  return suggestions.map((suggestion) => {
    const node = held.find((candidate) => candidate.fromSuggestion === suggestion)
    if (node !== undefined) {
      let current = node
      const seen = new Set([current.nodeId])
      while (current.revisedTo !== undefined && !seen.has(current.revisedTo)) {
        const next = held.find((candidate) => candidate.nodeId === current.revisedTo)
        if (next === undefined) break
        seen.add(next.nodeId)
        current = next
      }
      const delegated = view.expand(node.nodeId)?.source?.includes('via delegation') === true
      return {
        suggestion,
        label: current.label,
        status: current.withdrawn
          ? 'dropped'
          : delegated && current === node
            ? 'delegated'
            : 'person',
        ...(current.withdrawn ? {} : { node: current.nodeId }),
      }
    }
    const waiting = pending.find((candidate) => candidate.id === suggestion)
    const proposal = waiting?.proposal as { readonly label?: unknown } | undefined
    return {
      suggestion,
      label: typeof proposal?.label === 'string' ? proposal.label : suggestion,
      status: waiting === undefined ? 'dropped' : 'pending',
    }
  })
}

/**
 * Claims waiting for the person in this space that no evidence ties to an objective. Confirming one still makes it
 * theirs, but no objective will read as confirmed by it.
 */
export function unlinkedIn(
  view: SceneView,
  space: string,
): readonly { readonly suggestion: string; readonly label: string }[] {
  const scope = scopeOf(space)
  const linked = new Set(
    view.records.list(EVIDENCE_PREFIX).flatMap((record) => {
      const { suggestion } = record.value as LearningEvidence
      return suggestion === undefined ? [] : [suggestion]
    }),
  )
  return view
    .pendingSuggestions()
    .filter((waiting) => waiting.scope === scope && !linked.has(waiting.id))
    .flatMap(({ id, proposal }) =>
      proposal.kind === 'claim' || proposal.kind === 'node'
        ? [{ suggestion: id, label: proposal.label }]
        : [],
    )
}

export interface SessionEvent {
  readonly id: string
  readonly kind: LearningEvidence['kind']
  readonly at: number
  readonly recordedBy: string
  readonly assessment?: LearningEvidence['assessment']
  readonly move?: LearningEvidence['move']
  readonly candidate?: ObjectiveReading['candidates'][number]
  /** How the learner's words it rests on arrived, when it rests on a turn. */
  readonly wordsBy?: WordsBy
}

/** One plan as the person reads it afterwards. It holds no words of a turn. */
export interface SessionOutcome {
  readonly plan: string
  readonly thread: string
  readonly topic: string
  readonly status: Plan['status']
  readonly origin: Plan['origin']
  readonly startedAt: number
  readonly updatedAt: number
  readonly recordedBy: readonly string[]
  readonly steps: { readonly total: number; readonly done: number; readonly skipped: number }
  readonly objectives: readonly {
    readonly id: string
    readonly label: string
    readonly events: readonly SessionEvent[]
  }[]
}

/** Each plan of a space that has anything to show, oldest first, so it reads as what changed. */
export function sessionsOf(view: SceneView, space: string): readonly SessionOutcome[] {
  const evidence = evidenceOf(view, space)
  const objectives = objectivesOf(view, space)
  const candidate = (suggestion: string | undefined) =>
    objectives.flatMap((each) => each.candidates).find((each) => each.suggestion === suggestion)
  return view.records
    .list('plan/')
    .map((record) => record.value as Plan)
    .filter((plan) => plan.space === space)
    .sort((left, right) => left.createdAt - right.createdAt)
    .flatMap((plan) => {
      const own = evidence.filter((each) => each.plan === plan.id)
      if (own.length === 0 && plan.origin !== 'host') return []
      const planned = plan.steps.map((step) => step.objective ?? objectiveIdOf(space, step.focus))
      const touched = [...new Set([...planned, ...own.map((each) => each.objective)])]
      const count = (status: string): number =>
        plan.steps.filter((step) => step.status === status).length
      return [
        {
          plan: plan.id,
          thread: plan.thread,
          topic: plan.topic,
          status: plan.status,
          origin: plan.origin,
          startedAt: plan.createdAt,
          updatedAt: plan.updatedAt,
          recordedBy: [...new Set(own.map((each) => each.recordedBy))],
          steps: { total: plan.steps.length, done: count('done'), skipped: count('skipped') },
          objectives: touched.flatMap((id) => {
            const label = objectives.find((each) => each.id === id)?.label
            if (label === undefined) return []
            const events = own
              .filter((each) => each.objective === id)
              .map((each): SessionEvent => {
                const made = candidate(each.suggestion)
                return {
                  id: each.id,
                  kind: each.kind,
                  at: each.at,
                  recordedBy: each.recordedBy,
                  ...(each.assessment === undefined ? {} : { assessment: each.assessment }),
                  ...(each.move === undefined ? {} : { move: each.move }),
                  ...(made === undefined ? {} : { candidate: made }),
                  ...(each.source === undefined
                    ? {}
                    : { wordsBy: wordsByTurn(view, each.source.thread, each.source.turn) }),
                }
              })
            return [{ id, label, events }]
          }),
        },
      ]
    })
}

/** Every objective of a space as it reads now. The words stay out unless they are asked for. */
export function objectivesOf(
  view: SceneView,
  space: string,
  options: { readonly withWords?: boolean } = {},
): readonly ObjectiveReading[] {
  const evidence = evidenceOf(view, space)
  const named = new Map<string, string>()
  for (const record of view.records.list(OBJECTIVE_PREFIX)) {
    const objective = record.value as Objective
    if (objective.space === space) named.set(objective.id, objective.label)
  }
  for (const record of view.records.list('attempt/')) {
    const attempt = record.value as Attempt
    const id = objectiveIdOf(space, attempt.focus)
    if (!named.has(id) && evidence.some((each) => each.objective === id)) {
      named.set(id, attempt.focus)
    }
  }
  return [...named].map(([id, label]) => {
    const own = evidence.filter((each) => each.objective === id)
    const gap = gapOf(own)
    const suggestions = [...new Set(own.flatMap((each) => each.suggestion ?? []))]
    const candidates = candidatesOf(view, space, suggestions)
    const best = candidates.reduce<ObjectiveReading['candidates'][number]['status']>(
      (top, each) => (STATUS_RANK[each.status] > STATUS_RANK[top] ? each.status : top),
      'dropped',
    )
    const wrong = gap === undefined ? undefined : own.find((each) => each.id === gap.wrong)?.source
    return {
      id,
      label,
      attempts: own.filter((each) => each.kind === 'attempt').length,
      ...(gap === undefined ? {} : { gap }),
      confirmation: best === 'dropped' ? 'none' : best,
      candidates,
      moves: own.flatMap((each) =>
        each.move === undefined
          ? []
          : [
              {
                activity: each.move.activity,
                reason: each.move.reason,
                at: each.at,
                plan: each.plan,
              },
            ],
      ),
      corrections: own.flatMap((each) =>
        each.kind === 'feedback' && each.assessment !== undefined
          ? [{ text: each.assessment.reason, at: each.at }]
          : [],
      ),
      ...(options.withWords === true && gap !== undefined
        ? { wrongWords: wrong === undefined ? null : wordsOf(view, wrong) }
        : {}),
    }
  })
}
