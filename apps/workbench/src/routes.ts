import { randomUUID } from 'node:crypto'
import type { SceneWrites, Turn } from '@episteme/application'
import type { SceneRoute, SceneRouteContext } from '@episteme/service'
import { answerFrom, answerText, relevant, type Answer } from './answer.js'
import { BUILT_IN_LIBRARY, libraryProblems, type Library } from './blocks.js'
import { objectivesOf, sessionsOf, unlinkedIn } from './evidence.js'
import { learningRoutes } from './learning.js'
import { MaterialStore } from './materials.js'
import { ModelFailure, type ModelClient, type ModelMessage } from './model.js'
import { MAX_MATERIAL_BYTES, MaterialRefusal, parseMaterial } from './parse.js'
import { sharingRoutes } from './sharing.js'
import { recalledFor, understandingRoutes } from './understanding.js'
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
    route('GET', '/model', () => ({ name: model.name, simulated: model.simulated })),
    // What came of learning, session by session. No turn text: reaching the words is a separate step.
    route('GET', '/outcomes', ({ view, query }) => {
      const space = spaceOf(view, required(query, 'space'))
      return {
        objectives: objectivesOf(view, space.id),
        unlinked: unlinkedIn(view, space.id).length,
        sessions: sessionsOf(view, space.id),
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
      return { sessions: view.threads(scopeOf(space.id)) }
    }),
    route('GET', '/session', ({ view, query }) => {
      const thread = view.threadView(required(query, 'thread'))
      if (thread === undefined) refuse('unknown_thread', '这段对话不存在。')
      return {
        thread: thread.thread,
        turns: thread.turns.map((turn) => {
          const answer = view.records.get(`${ANSWER_PREFIX}${turn.id}`)
          return answer === undefined ? turn : { ...turn, answer: answer.value as Answer }
        }),
      }
    }),

    route('POST', '/ask', ask),
  ]
}
