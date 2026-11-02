/**
 * What a learning process is made of, as data. The runner in `learning.ts` knows only the four interactions; it
 * knows no block by name, so a new way of learning is a new entry here, not new code.
 *
 * Two levels, not the three MindLink's blocks have: nothing here yet shares a smaller step between blocks, so a
 * primitive level would hold no reuse.
 */

export type Interaction =
  /** The model explains, from the material. The person reads and moves on. */
  | 'tell'
  /** The person says something, the model responds, up to `maxRounds`. The person can ask for the explanation. */
  | 'dialog'
  /** A question, an answer, and feedback that says what it rests on. */
  | 'practice'
  /** What happened in this plan, read back from what was recorded. Calls no model. */
  | 'report'

export type QuestionKind = 'choice' | 'cloze' | 'short'

export interface Block {
  readonly id: string
  readonly title: string
  readonly interaction: Interaction
  /** Added to the system prompt. It cannot lift the rules on evidence, which come first. */
  readonly instruction?: string
  /** What a `dialog` opens with; `{focus}` is replaced. Fixed text, so opening a step spends nothing. */
  readonly opening?: string
  readonly maxRounds?: number
  readonly kinds?: readonly QuestionKind[]
  /** This block's share of a focus's time. */
  readonly weight: number
}

export interface Workflow {
  readonly id: string
  readonly title: string
  readonly description: string
  /** Once, at the start. */
  readonly opening: readonly string[]
  /** Once for each focus of the plan. */
  readonly perFocus: readonly string[]
  /** Once, at the end. */
  readonly closing: readonly string[]
  /** How many minutes a focus takes, which decides how many fit in the time. */
  readonly minutesPerFocus: number
  /** Whether a focus the person has already confirmed understanding of starts out skipped. */
  readonly skipsUnderstood: boolean
}

export interface Library {
  readonly blocks: readonly Block[]
  readonly workflows: readonly Workflow[]
}

export const BUILT_IN_LIBRARY: Library = {
  blocks: [
    {
      id: 'overview',
      title: '概览',
      interaction: 'tell',
      weight: 1,
      instruction: '用几句话说明这部分内容讲什么、重点在哪。不要展开细节。',
    },
    {
      id: 'explain',
      title: '讲解',
      interaction: 'tell',
      weight: 2,
      instruction:
        '用尽量短的讲解把这个重点讲清楚，先说结论，再说理由，不要写“结论”“理由”这样的小标题。',
    },
    {
      id: 'check',
      title: '快速检查',
      interaction: 'practice',
      weight: 1,
      kinds: ['choice', 'cloze'],
    },
    {
      id: 'retell',
      title: '说说你的理解',
      interaction: 'dialog',
      weight: 2,
      maxRounds: 3,
      opening: '先别看材料，用你自己的话说说“{focus}”是怎么回事。说错也没关系。',
      instruction:
        '学习者刚说了自己的理解。先指出说对的地方，再指出和材料不符或漏掉的地方并给出依据，最后提一个追问。直接问，不要说明你在追问。不要把答案全说出来。',
    },
    {
      id: 'probe',
      title: '举例和反例',
      interaction: 'dialog',
      weight: 2,
      maxRounds: 3,
      opening: '围绕“{focus}”举一个例子或反例：什么情况下它起作用，什么情况下不起作用？',
      instruction:
        '评价学习者的例子或反例是否符合材料，指出依据。如果例子不成立，说明差在哪里，再提一个追问。直接问，不要说明你在追问。',
    },
    {
      id: 'practice',
      title: '练习',
      interaction: 'practice',
      weight: 2,
      kinds: ['short', 'choice'],
    },
    {
      id: 'reflect',
      title: '回顾',
      interaction: 'dialog',
      weight: 1,
      maxRounds: 1,
      opening: '回头看“{focus}”：你原来的想法有哪里变了？还有什么没弄懂？',
      instruction: '根据学习者的回顾，指出还值得回到材料看的地方并给出依据，不要再提问。',
    },
    { id: 'summary', title: '总结', interaction: 'report', weight: 1 },
  ],
  workflows: [
    {
      id: 'speedrun',
      title: '速通',
      description: '时间有限时用。短讲解加快速检查，跳过你已确认理解的内容。',
      opening: ['overview'],
      perFocus: ['explain', 'check'],
      closing: ['summary'],
      minutesPerFocus: 15,
      skipsUnderstood: true,
    },
    {
      id: 'deep',
      title: '深入',
      description: '想真正弄懂时用。先说你的理解，再通过追问和例子修正。随时可以改成直接讲解。',
      opening: ['overview'],
      perFocus: ['retell', 'probe', 'practice'],
      closing: ['reflect', 'summary'],
      minutesPerFocus: 30,
      skipsUnderstood: false,
    },
  ],
}

const INTERACTIONS: readonly Interaction[] = ['tell', 'dialog', 'practice', 'report']

/** What is wrong with a library, so a mistake in it is refused at start rather than found halfway through a plan. */
export function libraryProblems(library: Library): readonly string[] {
  const problems: string[] = []
  const known = new Set(library.blocks.map((block) => block.id))
  if (known.size !== library.blocks.length) problems.push('two blocks share an id')
  for (const block of library.blocks) {
    if (!INTERACTIONS.includes(block.interaction)) {
      problems.push(`block "${block.id}" has unknown interaction "${String(block.interaction)}"`)
    }
    if (!(block.weight > 0)) problems.push(`block "${block.id}" needs a positive weight`)
    if (block.interaction === 'dialog' && block.opening === undefined) {
      problems.push(`dialog "${block.id}" needs an opening`)
    }
    if (block.interaction === 'dialog' && !((block.maxRounds ?? 0) > 0)) {
      // No block may keep asking for ever (PRD G2.4).
      problems.push(`dialog "${block.id}" needs a positive maxRounds`)
    }
  }
  for (const workflow of library.workflows) {
    for (const id of [...workflow.opening, ...workflow.perFocus, ...workflow.closing]) {
      if (!known.has(id)) problems.push(`workflow "${workflow.id}" names unknown block "${id}"`)
    }
    if (!(workflow.minutesPerFocus > 0)) {
      problems.push(`workflow "${workflow.id}" needs positive minutesPerFocus`)
    }
  }
  return problems
}
