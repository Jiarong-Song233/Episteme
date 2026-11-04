import type { Answer, MaterialSummary, Space } from '@episteme/workbench'

/** The page's only way to the graph: the same REST API any other client has. */

export type { Answer, Citation, Evidence, MaterialSummary, Space } from '@episteme/workbench'

export interface Session {
  readonly id: string
  readonly title: string
  readonly createdAt: number
}

export interface Turn {
  readonly id: string
  readonly speaker: 'learner' | 'agent'
  readonly text: string
  readonly answer?: Answer
}

export interface MaterialText {
  readonly id: string
  readonly title: string
  readonly text: string
  readonly version: number
}

export interface Failure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface Asked {
  readonly thread: string
  readonly turn: string
  readonly reply?: string
  readonly answer?: Answer
  readonly failure?: Failure
}

export interface PendingCandidate {
  readonly id: string
  readonly proposal: {
    readonly kind: string
    readonly label: string
    readonly nodeType?: string
    readonly properties?: Readonly<Record<string, unknown>>
  }
  readonly rationale: string
  readonly basis?: string
}

export interface Understood {
  readonly nodeId: string
  readonly label: string
}

export interface Understanding {
  readonly nodes: readonly Understood[]
  readonly pending: readonly PendingCandidate[]
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
  } catch {
    throw new ApiError('offline', '连不上服务。请确认它还在运行，然后重试。')
  }
  // A session lives as long as the service: after a restart the page has to fetch a new one.
  if (response.status === 401) {
    throw new ApiError('signed_out', '服务重启过了。请刷新页面。')
  }
  const payload = (await response.json().catch(() => ({}))) as {
    readonly code?: string
    readonly error?: string
  }
  if (!response.ok) {
    throw new ApiError(
      payload.code ?? 'failed',
      payload.error ?? `请求失败（${response.status}）。`,
    )
  }
  return payload as T
}

const scene = (path: string, body?: unknown): Promise<unknown> =>
  request(`/scene/workbench${path}`, body)

const encoded = (value: string): string => encodeURIComponent(value)

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = () => reject(new ApiError('unreadable', `读不了文件“${file.name}”。`))
    reader.readAsDataURL(file)
  })
}

export const api = {
  model: () => scene('/model') as Promise<{ name: string; simulated: boolean }>,
  spaces: () => scene('/spaces') as Promise<{ spaces: readonly Space[] }>,
  createSpace: (name: string) => scene('/spaces', { name }) as Promise<{ space: Space }>,
  updateSpace: (space: string, change: { name?: string; archived?: boolean }) =>
    scene('/spaces/update', { space, ...change }) as Promise<{ space: Space }>,
  materials: (space: string) =>
    scene(`/materials?space=${encoded(space)}`) as Promise<{
      materials: readonly MaterialSummary[]
    }>,
  material: (id: string) =>
    scene(`/material?id=${encoded(id)}`) as Promise<{ material: MaterialText }>,
  async upload(space: string, file: File) {
    return scene('/materials', {
      space,
      fileName: file.name,
      contentBase64: await base64Of(file),
    }) as Promise<{ id: string; duplicate: boolean }>
  },
  async replace(id: string, file: File) {
    return scene('/materials/replace', {
      id,
      fileName: file.name,
      contentBase64: await base64Of(file),
    })
  },
  deleteMaterial: (id: string) => scene('/materials/delete', { id }),
  sessions: (space: string) =>
    scene(`/sessions?space=${encoded(space)}`) as Promise<{ sessions: readonly Session[] }>,
  session: (thread: string) =>
    scene(`/session?thread=${encoded(thread)}`) as Promise<{ turns: readonly Turn[] }>,
  ask: (space: string, question: string, thread: string | undefined, retry: boolean) =>
    scene('/ask', {
      space,
      question,
      ...(thread === undefined ? {} : { thread }),
      ...(retry ? { retry } : {}),
    }) as Promise<Asked>,
  candidates: (space: string, thread: string, reply: string) =>
    scene('/candidates', { space, thread, reply }) as Promise<{
      suggestions: readonly unknown[]
      message?: string
    }>,
  understanding: (space: string) =>
    scene(`/understanding?space=${encoded(space)}`) as Promise<Understanding>,
  // The person's decision, through the API's own decision route. The workbench has no other way to make one.
  accept: (id: string) => request('/suggestions/decide', { id, action: 'accept' }),
  dismiss: (id: string) => request('/suggestions/decide', { id, action: 'dismiss' }),
  acceptEdited: (candidate: PendingCandidate, label: string) =>
    request('/suggestions/decide', {
      id: candidate.id,
      action: 'modify',
      proposal: { ...candidate.proposal, label },
    }),
}
