import { randomUUID } from 'node:crypto'
import type { SceneView, SceneWrites, Thread, Turn } from '@episteme/application'
import type { SceneRoute, SceneRouteContext } from '@episteme/service'
import { answerFrom, answerText, relevant, type Answer } from './answer.js'
import { BUILT_IN_LIBRARY, libraryProblems, type Library } from './blocks.js'
import { conversationRoutes, shownThread } from './conversations.js'
import {
  EVIDENCE_PREFIX,
  evidenceOf,
  objectivesOf,
  sessionsOf,
  unlinkedIn,
  type LearningEvidence,
} from './evidence.js'
import { learningRoutes } from './learning.js'
import { MaterialStore } from './materials.js'
import { ModelFailure, type ModelClient, type ModelMessage } from './model.js'
import type { ModelSettings } from './model-settings.js'
import { MAX_MATERIAL_BYTES, MaterialRefusal, parseMaterial } from './parse.js'
import { sharingRoutes } from './sharing.js'
import { heldNodes, recalledFor, understandingRoutes } from './understanding.js'
import {
  ANSWER_PREFIX,
  openSpaceOf,
  refuse,
  required,
  scopeOf,
  SPACE_PREFIX,
  spaceOf,
  text,
  type Space,
} from './requests.js'

export { scopeOf, type Space } from './requests.js'

/**
 * The workbench's REST routes, under `/api/v1/scene/<name>`.
 *
 * Nothing here decides or writes understanding. Candidates reach the person's review queue through `distill`, and the
 * person's decision goes through the API's own decision route.
 */

const MAX_NAME = 80
const MAX_QUESTION = 4000
const THREAD_TITLE = 40
/** Base64 grows a file by a third; the rest of the body is a few short fields. */
const MAX_UPLOAD_BODY = Math.ceil((MAX_MATERIAL_BYTES * 4) / 3) + 4096

function bytesOf(body: Readonly<Record<string, unknown>>): Uint8Array {
  const content = body['contentBase64']
  if (typeof content !== 'string') refuse('invalid_request', '"contentBase64" must be a string')
  return Buffer.from(content, 'base64')
}

/** A refusal of the material, answered as a refusal rather than as a failure of the service. */
async function parsing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof MaterialRefusal) refuse(error.code, error.message)
    throw error
  }
}

/** The earlier turns as a model reads them, without the question just asked. */
function historyOf(turns: readonly Turn[]): readonly ModelMessage[] {
  return turns.map((turn) => ({
    role: turn.speaker === 'learner' ? 'user' : 'assistant',
    content: turn.text,
  }))
}

/** A short title from the first question. */
/** The turns said on this thread itself, without those it carries over from the line it branched from. */
function ownTurnsOf(view: SceneView, thread: string): readonly Turn[] {
  return (view.threadView(thread)?.turns ?? []).filter((turn) => turn.thread === thread)
}

/** "Title · 分支 n": a branch is told apart from its line and from the line's other branches. */
function branchTitle(view: SceneView, from: Thread): string {
  const siblings = view.threads(from.scope).filter((thread) => thread.parent?.thread === from.id)
  return `${shownThread(view, from).title} · 分支 ${siblings.length + 1}`.slice(0, MAX_NAME)
}

function titleFrom(question: string): string {
  const line = question.trim().split('\n')[0] ?? ''
  return line.length > THREAD_TITLE ? `${line.slice(0, THREAD_TITLE)}…` : line
}

export interface WorkbenchRouteOptions {
  readonly model: ModelClient
  /** Injected, so a test can fix the time. */
  readonly now?: () => number
  /** The ways of learning on offer. Defaults to the built-in ones. */
  readonly library?: Library
  /** Lets the person choose the model on the page. `model` should then be this same object. */
  readonly modelSettings?: ModelSettings
}

/** The routes over one graph. Make one set per service: its material store belongs to that graph's connection. */
export function workbenchRoutes(options: WorkbenchRouteOptions): readonly SceneRoute[] {
  const { model } = options
  const now = options.now ?? Date.now
  const library = options.library ?? BUILT_IN_LIBRARY
  const problems = libraryProblems(library)
  if (problems.length > 0) throw new Error(`Invalid learning library: ${problems.join('; ')}`)
  let opened: Promise<MaterialStore> | undefined
  const materialsOf = (writes: SceneWrites): Promise<MaterialStore> => {
    opened ??= MaterialStore.open(writes.log('materials'))
    return opened
  }

  const route = (
    method: SceneRoute['method'],
    path: string,
    handle: SceneRoute['handle'],
    maxBodyBytes?: number,
  ): SceneRoute => ({
    method,
    path,
    handle,
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
  })

  async function ask({ view, writes, body }: SceneRouteContext) {
    const space = openSpaceOf(view, text(body, 'space'))
    const question = text(body, 'question', MAX_QUESTION).trim()
    const scope = scopeOf(space.id)
    const threadId =
      typeof body['thread'] === 'string'
        ? body['thread']
        : (await writes.openThread({ title: titleFrom(question), scope })).id
    const thread = view.threadView(threadId)
    if (thread === undefined || thread.thread.scope !== scope) {
      refuse('unknown_thread', '这个空间里没有这段对话。')
    }
    // Retrying after a failed call answers the same turn, instead of asking the question twice.
    const last = thread.turns.at(-1)
    const retrying = body['retry'] === true && last?.speaker === 'learner' && last.text === question
    const earlier = retrying ? thread.turns.slice(0, -1) : thread.turns
    const turn = retrying
      ? last
      : await writes.appendTurn(threadId, {
          speaker: 'learner',
          text: question,
          writtenWith: 'person', // this route takes only the person's credential (ADR 0020)
        })

    const store = await materialsOf(writes)
    let hits = store.search(writes.actor, space.id, question)
    // A follow-up such as "why?" says little on its own, so it is read with the question before it.
    if (relevant(hits).length === 0) {
      const previous = earlier.findLast((candidate) => candidate.speaker === 'learner')
      if (previous !== undefined) {
        hits = store.search(writes.actor, space.id, `${previous.text}\n${question}`)
      }
    }
    const recalled = await recalledFor(view, space.id, question)
    let answer: Answer
    try {
      answer = await answerFrom({ question, hits, history: historyOf(earlier), model, recalled })
    } catch (error) {
      if (!(error instanceof ModelFailure)) throw error
      return {
        thread: threadId,
        turn: turn.id,
        failure: { code: error.code, message: error.message, retryable: error.retryable },
      }
    }
    const reply = await writes.appendTurn(threadId, {
      speaker: 'agent',
      text: answerText(answer),
      by: `model:${model.name}`,
    })
    await view.records.put(`${ANSWER_PREFIX}${reply.id}`, answer)
    return { thread: threadId, turn: turn.id, reply: reply.id, answer }
  }

  return [
    ...learningRoutes({ model, library, now, materialsOf }),
    ...understandingRoutes({ model, now, materialsOf }),
    ...sharingRoutes({ now }),
    route('GET', '/model', () =>
      options.modelSettings === undefined
        ? { name: model.name, simulated: model.simulated }
        : { ...options.modelSettings.view() },
    ),
    // Choosing the model is the person's: neither route is open to an agent's credential (route-access.ts).
    route('POST', '/model/settings', async ({ body }) => {
      const settings = options.modelSettings
      if (settings === undefined) refuse('not_found', '这个服务不能在页面上设置模型。')
      const address = text(body, 'baseUrl', 500).trim()
      let parsed: URL
      try {
        parsed = new URL(address)
      } catch {
        refuse('invalid_request', '服务地址要以 http:// 或 https:// 开头。')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        refuse('invalid_request', '服务地址要以 http:// 或 https:// 开头。')
      }
      // Left out: keep what was saved. An empty string: remove it.
      const optional = (key: string): string | undefined =>
        body[key] === undefined ? undefined : body[key] === '' ? '' : text(body, key, 500).trim()
      const apiKey = optional('apiKey')
      const reasoningEffort = optional('reasoningEffort')
      try {
        return {
          model: await settings.save({
            baseUrl: address.replace(/\/+$/, ''),
            model: text(body, 'model', 200).trim(),
            ...(apiKey === undefined ? {} : { apiKey }),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          }),
        }
      } catch (error) {
        if (!(error instanceof ModelFailure)) throw error
        return { failure: { code: error.code, message: error.message } }
      }
    }),
    route('POST', '/model/clear', async () => {
      const settings = options.modelSettings
      if (settings === undefined) refuse('not_found', '这个服务不能在页面上设置模型。')
      try {
        return { model: await settings.clear() }
      } catch (error) {
        if (!(error instanceof ModelFailure)) throw error
        return { failure: { code: error.code, message: error.message } }
      }
    }),
    // What came of learning, session by session. No turn text: reaching the words is a separate step.
    route('GET', '/outcomes', ({ view, query }) => {
      const space = spaceOf(view, required(query, 'space'))
      return {
        objectives: objectivesOf(view, space.id),
        unlinked: unlinkedIn(view, space.id).length,
        sessions: sessionsOf(view, space.id),
      }
    }),
    // The person says which learning objective one of their understandings is about, so what practice shows on that
    // objective can ask about it. Not named in route-access.ts: an agent ties its own suggestions with learn_observe,
    // never what the person already holds. It records evidence, and changes nothing the person holds.
    route('POST', '/objectives/link', async ({ view, body }) => {
      const space = openSpaceOf(view, text(body, 'space'))
      const objective = objectivesOf(view, space.id).find(
        (each) => each.id === text(body, 'objective'),
      )
      if (objective === undefined) refuse('unknown_objective', '这个空间里没有这个学习目标。')
      const node = heldNodes(view, space.id).find(
        (each) =>
          each.nodeId === text(body, 'node') &&
          !each.withdrawn &&
          // Someone else's published item, held by citing it: its words are not the person's to tie.
          each.adoptedFrom === undefined,
      )
      if (node === undefined) {
        refuse('unknown_node', '这条理解不在这个空间里，已经撤回，或是引用的别人的成果。')
      }
      if (node.fromSuggestion === undefined) {
        refuse('no_origin', '这条理解没有记录它从哪条候选来，没法关联到学习目标。')
      }
      if (objective.candidates.some((each) => each.node === node.nodeId)) {
        return { linked: false, objective }
      }
      const earlier = evidenceOf(view, space.id).filter((each) => each.objective === objective.id)
      const evidence: LearningEvidence = {
        id: `ev_${randomUUID()}`,
        seq: view.records.list(EVIDENCE_PREFIX).length + 1,
        at: Date.now(),
        recordedBy: 'person',
        space: space.id,
        plan: earlier.at(-1)?.plan ?? '',
        objective: objective.id,
        kind: 'candidate',
        suggestion: node.fromSuggestion,
      }
      await view.records.put(`${EVIDENCE_PREFIX}${evidence.id}`, evidence)
      return {
        linked: true,
        objective: objectivesOf(view, space.id).find((each) => each.id === objective.id),
      }
    }),

    route('GET', '/spaces', ({ view }) => ({
      spaces: view.records
        .list(SPACE_PREFIX)
        .map((record) => record.value as Space)
        .sort((left, right) => left.createdAt - right.createdAt),
    })),
    route('POST', '/spaces', async ({ view, body }) => {
      const space: Space = {
        id: `sp_${randomUUID()}`,
        name: text(body, 'name', MAX_NAME).trim(),
        archived: false,
        createdAt: now(),
      }
      await view.records.put(`${SPACE_PREFIX}${space.id}`, space)
      return { space }
    }),
    route('POST', '/spaces/update', async ({ view, body }) => {
      const kept = spaceOf(view, text(body, 'space'))
      const space: Space = {
        ...kept,
        ...(body['name'] === undefined ? {} : { name: text(body, 'name', MAX_NAME).trim() }),
        ...(typeof body['archived'] === 'boolean' ? { archived: body['archived'] } : {}),
      }
      await view.records.put(`${SPACE_PREFIX}${space.id}`, space)
      return { space }
    }),

    route('GET', '/materials', async ({ view, writes, query }) => {
      const space = spaceOf(view, required(query, 'space'))
      const store = await materialsOf(writes)
      return { materials: store.list(writes.actor, space.id) }
    }),
    route('GET', '/material', async ({ writes, query }) => {
      const store = await materialsOf(writes)
      const material = store.get(writes.actor, required(query, 'id'))
      if (material === undefined) refuse('unknown_material', '这份材料不存在或已被删除。')
      const { owner: _owner, ...shown } = material
      return { material: shown }
    }),
    route(
      'POST',
      '/materials',
      async ({ view, writes, body }) => {
        const space = openSpaceOf(view, text(body, 'space'))
        const fileName = text(body, 'fileName', 255)
        const parsed = await parsing(() => parseMaterial(fileName, bytesOf(body)))
        const store = await materialsOf(writes)
        const { material, duplicate } = await store.add({
          owner: writes.actor,
          space: space.id,
          title: fileName,
          parsed,
          at: now(),
        })
        return {
          id: material.id,
          duplicate,
          materials: store.list(writes.actor, space.id),
        }
      },
      MAX_UPLOAD_BODY,
    ),
    route(
      'POST',
      '/materials/replace',
      async ({ writes, body }) => {
        const fileName = text(body, 'fileName', 255)
        const parsed = await parsing(() => parseMaterial(fileName, bytesOf(body)))
        const store = await materialsOf(writes)
        const material = await store.replace(writes.actor, text(body, 'id'), parsed)
        if (material === undefined) refuse('unknown_material', '这份材料不存在或已被删除。')
        return { id: material.id, version: material.version }
      },
      MAX_UPLOAD_BODY,
    ),
    route('POST', '/materials/delete', async ({ writes, body }) => {
      const store = await materialsOf(writes)
      if (!(await store.remove(writes.actor, text(body, 'id')))) {
        refuse('unknown_material', '这份材料不存在或已被删除。')
      }
      return { deleted: true }
    }),

    route('GET', '/sessions', ({ view, query }) => {
      const space = spaceOf(view, required(query, 'space'))
      // As the person named them, without the ones they archived (conversations.ts). A branch names its `parent`;
      // `ownTurns` counts only what was said on it, not what it carries over from the line it left.
      return {
        sessions: view
          .threads(scopeOf(space.id))
          .map((thread) => ({
            ...shownThread(view, thread),
            ownTurns: ownTurnsOf(view, thread.id).length,
          }))
          .filter((thread) => !thread.archived),
      }
    }),
    route('GET', '/session', ({ view, query }) => {
      const thread = view.threadView(required(query, 'thread'))
      if (thread === undefined) refuse('unknown_thread', '这段对话不存在。')
      const id = thread.thread.id
      return {
        thread: shownThread(view, thread.thread),
        // `inherited`: the turn was said on a line this branch left, before it left.
        turns: thread.turns.map((turn) => {
          const answer = view.records.get(`${ANSWER_PREFIX}${turn.id}`)
          const shown = { ...turn, inherited: turn.thread !== id }
          return answer === undefined ? shown : { ...shown, answer: answer.value as Answer }
        }),
      }
    }),
    // The person's: a new line of a conversation from one of its turns. The original and its other lines stay as
    // they are. Not named in route-access.ts, so an agent's credential cannot open one here.
    route('POST', '/sessions/fork', async ({ view, writes, body }) => {
      const space = openSpaceOf(view, text(body, 'space'))
      const from = view.threadView(text(body, 'thread', 200))
      if (from === undefined || from.thread.scope !== scopeOf(space.id)) {
        refuse('unknown_thread', '这个空间里没有这段对话。')
      }
      const turn = text(body, 'turn', 200)
      if (!from.turns.some((each) => each.id === turn)) {
        refuse('unknown_turn', '这段对话里没有这句话。')
      }
      const title =
        body['title'] === undefined || body['title'] === ''
          ? branchTitle(view, from.thread)
          : text(body, 'title', MAX_NAME).trim().replace(/\s+/g, ' ')
      const fork = await writes.forkThread(from.thread.id, turn, title)
      return { session: { ...shownThread(view, fork), ownTurns: 0 } }
    }),

    route('POST', '/ask', ask),
    ...conversationRoutes(),
  ]
}
