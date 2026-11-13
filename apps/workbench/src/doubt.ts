import type { SceneView } from '@episteme/application'
import { objectivesOf, type LearningEvidence } from './evidence.js'
import { scopeOf } from './requests.js'

/** The state an attempt that fell short puts to the person: something they hold may not stand. */
const DOUBT = { dimension: 'conflict', level: 'suspected' } as const
/** Under doubt, as the person themself recorded: a new proposal would only ask again. */
const DOUBT_SETTLED: ReadonlySet<string> = new Set(['suspected', 'open'])

/**
 * Whether the person has put this understanding under doubt. A doubt they worked through (`resolved`) is not one: what
 * they hold stands again.
 */
export const isDoubted = (node: {
  readonly understanding: readonly { readonly id: string; readonly level: string }[]
}): boolean =>
  node.understanding.some(
    (dimension) => dimension.id === DOUBT.dimension && DOUBT_SETTLED.has(dimension.level),
  )

/** Who judged the answer, said to the person, since only the agent's judgement carries its own reason. */
const JUDGED_BY: Readonly<Record<string, string>> = {
  mechanical: '程序对照答案判定',
  model: '模型估计，可能看错',
}

/**
 * Puts an attempt that fell short to the person, on what they hold about its objective: one pending state change per
 * held node, that a conflict is suspected (a negotiated learner model: the evidence proposes, the person decides).
 *
 * Nothing changes until they decide, and a node already doubted, or with the same draft waiting, gets none. A
 * delegation never decides it: a conflict is a side the person picks (ADR 0016). An answer on the page and one an
 * agent relayed reach it alike. Returns the drafts made.
 */
export async function proposeDoubt(
  view: SceneView,
  evidence: LearningEvidence,
  proposedBy: string,
): Promise<readonly string[]> {
  const assessment = evidence.assessment
  const verdict = assessment?.verdict
  if (evidence.kind !== 'attempt' || (verdict !== 'partial' && verdict !== 'contradicts')) return []
  const reading = objectivesOf(view, evidence.space).find((each) => each.id === evidence.objective)
  const held = (reading?.candidates ?? []).flatMap((candidate) =>
    candidate.node !== undefined &&
    (candidate.status === 'person' || candidate.status === 'delegated')
      ? [candidate.node]
      : [],
  )
  const waiting = view
    .pendingSuggestions()
    .flatMap(({ proposal }) =>
      proposal.kind === 'state' && proposal.dimension === DOUBT.dimension ? [proposal.target] : [],
    )
  const how = verdict === 'partial' ? '只答对了一部分' : '没答对'
  const judged = JUDGED_BY[assessment?.method ?? '']
  // A reason may end a sentence of its own, and the words after it start another.
  const reason = (assessment?.reason ?? '').replace(/[。.\s]+$/u, '')
  const rationale =
    judged === undefined
      ? `练习里${how}：${reason}。确认之前，你的理解不变。`
      : `这道题${how}（${judged}）：${reason}。确认之前，你的理解不变。`
  const made: string[] = []
  for (const node of new Set(held)) {
    const level = view.understandingOf(node).find((each) => each.id === DOUBT.dimension)?.level
    if ((level !== undefined && DOUBT_SETTLED.has(level)) || waiting.includes(node)) continue
    const proposed = await view.propose(
      { kind: 'state', target: node, dimension: DOUBT.dimension, level: DOUBT.level },
      { proposedBy, rationale, scope: scopeOf(evidence.space) },
    )
    if (proposed.ok) made.push(proposed.suggestion.id)
  }
  return made
}
