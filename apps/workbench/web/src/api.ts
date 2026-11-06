import type {
  Answer,
  Challenge,
  HeldNode,
  MaterialSummary,
  ObjectiveReading,
  Plan,
  PublicQuestion,
  SessionOutcome,
  Space,
  TrailEntry,
  WordsBy,
} from '@episteme/workbench'

/** The page's only way to the graph: the same REST API any other client has. */

export type {
  Answer,
  Challenge,
  Citation,
  Evidence,
  HeldNode,
  MaterialSummary,
  ObjectiveReading,
  Plan,
  PublicQuestion,
  SessionEvent,
  SessionOutcome,
  Space,
  Step,
  TrailEntry,
  WordsBy,
} from '@episteme/workbench'

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
  /** Absent only on a turn still being sent. */
  readonly by?: string
  readonly writtenWith?: 'person' | 'agent'
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
    readonly label?: string
    readonly relation?: string
    readonly nodeType?: string
    readonly properties?: Readonly<Record<string, unknown>>
  }
  readonly rationale: string
  readonly basis?: string
  readonly wordsBy?: WordsBy
  /** A pending relation in words. It can be accepted only once both its ends are confirmed. */
  /** Another wording, held or waiting, that says nearly the same. */
  readonly similar?: string
  readonly link?: { readonly fromLabel: string; readonly toLabel: string; readonly ready: boolean }
}

export interface Dimension {
  readonly id: string
  readonly labelZh: string
  readonly levelLabelsZh: readonly { readonly level: string; readonly label: string }[]
}

export interface Understanding {
  readonly nodes: readonly HeldNode[]
  readonly pending: readonly PendingCandidate[]
  readonly challenges: readonly Challenge[]
  readonly dimensions: readonly Dimension[]
}

export interface Offered {
  readonly suggestions: readonly { readonly id: string }[]
  readonly message?: string
  readonly failure?: Failure
}

export interface WorkflowInfo {
  readonly id: string
  readonly title: string
  readonly description: string
}

export interface BlockInfo {
  readonly id: string
  readonly title: string
  readonly interaction: string
  readonly maxRounds?: number
}

export interface PlanProposal {
  readonly plan: Plan
  readonly notice?: string
}

export interface PlanDetail {
  readonly plan: Plan
  readonly turns: readonly Turn[]
  readonly question?: PublicQuestion
}

export interface PlanMove {
  readonly plan: Plan
  readonly question?: PublicQuestion
  readonly failure?: Failure
}

export interface Status {
  readonly plans: readonly {
    readonly id: string
    readonly topic: string
    readonly status: Plan['status']
    readonly done: number
    readonly total: number
  }[]
  readonly checked: { readonly correct: number; readonly total: number }
  readonly estimated: {
    readonly correct: number
    readonly partial: number
    readonly wrong: number
    readonly unjudged: number
  }
  readonly confirmed: number
  readonly review: readonly {
    readonly focus: string
    readonly dueAt: number
    readonly due: boolean
    readonly reason: string
  }[]
}

export interface Me {
  readonly actorId: string
  readonly mode: 'local' | 'shared'
  readonly sharing: boolean
  readonly names: Readonly<Record<string, string>>
}

export interface PublicationSummary {
  readonly id: string
  readonly author: string
  readonly createdAt: number
  readonly rootLabel: string
  readonly members: number
  readonly version: number
  readonly note?: string
}

export interface PublicNode {
  readonly nodeId: string
  readonly label: string
  readonly author: string
  readonly origin?: { readonly excerpt?: string }
  readonly confirmation: 'person' | 'delegation'
}

export interface PublicationDetail {
  readonly publication: {
    readonly id: string
    readonly actorId: string
    readonly createdAt: number
    readonly root: string
    readonly note?: string
  }
  readonly live: boolean
  readonly nodes: readonly PublicNode[]
  readonly edges: readonly {
    readonly id: string
    readonly type: string
    readonly from: string
    readonly to: string
  }[]
  readonly versions: readonly string[]
  readonly responses: readonly {
    readonly publication: string
    readonly author: string
    readonly node: string
    readonly label: string
    readonly relation: string
    readonly target: string
    readonly note?: string
  }[]
  readonly answered: readonly {
    readonly node: string
    readonly label: string
    readonly relation: string
    readonly target: string
    readonly space: string
  }[]
  readonly cited: readonly {
    readonly node: string
    readonly space: string
    readonly publication: string
  }[]
}

export interface PublicationPlan {
  readonly public: { readonly nodes: readonly PublicNode[] }
  readonly private: { readonly otherNodes: number }
}

export interface PublishChoices {
  readonly related: readonly { readonly nodeId: string; readonly label: string }[]
  readonly published?: string
  readonly earlier?: { readonly id: string; readonly rootLabel: string }
  /** Why the person answered as they did, so far only theirs: publishing it is their choice. */
  readonly reason?: string
}

export interface PublicationUpdate {
  readonly adopted: string
  readonly newer: string
  readonly author: string
  readonly added: readonly { readonly nodeId: string; readonly label: string }[]
  readonly removed: readonly { readonly nodeId: string; readonly label: string }[]
}

export interface LineageStep {
  readonly nodeId?: string
  readonly label?: string
  readonly author: string
  readonly publication?: string
  readonly relation?: string
  readonly reason?: string
  readonly withdrawn?: true
}

interface PublishRequest {
  readonly root: string
  readonly include?: readonly string[]
  readonly supersedes?: string
  readonly note?: string
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
  // A session lives as long as the service: after a restart the page has to fetch a new one, or sign in again.
  if (response.status === 401) {
    throw new ApiError('signed_out', '需要重新进入：请刷新页面。')
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

/** The model behind answers, as the page may see it: never the key. */
export interface ModelInfo {
  readonly name: string
  readonly simulated: boolean
  readonly source?: 'environment' | 'settings' | 'none'
  readonly baseUrl?: string
  readonly model?: string
  readonly hasKey?: boolean
  readonly reasoningEffort?: string
}

export type ModelChange =
  | { readonly model: ModelInfo }
  | { readonly failure: { readonly code: string; readonly message: string } }

/** One agent of this computer and its connection to the workbench. */
export interface AgentInfo {
  readonly id: string
  readonly name: string
  readonly maker?: string
  readonly kind: 'cli' | 'editor' | 'desktop' | 'extension' | 'custom'
  readonly installed: boolean
  /** Absent when its settings could not be read to tell. */
  readonly connected?: boolean
  readonly current?: boolean
  readonly how: 'command' | 'settings' | 'manual'
  readonly file?: string
  readonly address: string
  readonly after?: string
  readonly use?: AgentUse
}

export interface AgentUse {
  readonly key: string
  readonly agent?: string
  readonly name: string
  readonly version?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly calls: number
  readonly lastTool?: string
}

export interface CustomAgentRequest {
  readonly name: string
  readonly file?: string
  readonly key?: string
  readonly style?: string
}

/** A conversation of the workbench, across spaces, as the person named it. */
export interface ConversationInfo {
  readonly id: string
  readonly title: string
  readonly space?: { readonly id: string; readonly name: string }
  readonly createdAt: number
  readonly lastAt: number
  readonly turns: number
  readonly agents: readonly string[]
  readonly byPerson: boolean
  readonly models: readonly string[]
  readonly archived: boolean
}

/** A conversation an agent of this computer keeps for itself. */
export interface AgentSessionInfo {
  readonly agent: string
  readonly id: string
  readonly title: string
  readonly project?: string
  readonly updatedAt: number
  readonly bytes?: number
}

export interface AgentSessionDetail {
  readonly summary: AgentSessionInfo
  readonly messages: readonly {
    readonly role: 'user' | 'assistant' | 'tool'
    readonly text: string
    readonly at?: number
  }[]
  readonly truncated: boolean
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
  me: () => request<Me>('/me'),
  async signIn(token: string): Promise<void> {
    try {
      await request('/session', { token })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'signed_out') {
        throw new ApiError('bad_token', '这个令牌不对，或者已经被撤销。')
      }
      throw error
    }
  },
  publications: (query: string, author: string | undefined) => {
    const asked = new URLSearchParams()
    if (query !== '') asked.set('q', query)
    if (author !== undefined) asked.set('author', author)
    return request<{ publications: readonly PublicationSummary[] }>(
      `/publications${asked.size === 0 ? '' : `?${asked.toString()}`}`,
    )
  },
  publication: (id: string) =>
    scene(`/sharing/publication?id=${encoded(id)}`) as Promise<PublicationDetail>,
  publishable: (space: string, node: string) =>
    scene(
      `/sharing/publishable?space=${encoded(space)}&node=${encoded(node)}`,
    ) as Promise<PublishChoices>,
  // Publishing, withdrawing and adopting are the person's, through the API's own routes. A scene route cannot do them.
  previewPublication: (body: PublishRequest) =>
    request<PublicationPlan>('/publications/preview', body),
  publish: (body: PublishRequest) =>
    request<{ publication: { id: string } }>('/publications', body),
  withdrawPublication: (id: string) => request(`/publications/${encoded(id)}/withdraw`, {}),
  adopt: (publication: string, node: string, dimensions: Readonly<Record<string, string>>) =>
    request(`/publications/${encoded(publication)}/adopt`, { node, dimensions }),
  placeCited: (space: string, publication: string, node: string) =>
    scene('/sharing/cite', { space, publication, node }),
  respond: (
    space: string,
    publication: string,
    node: string,
    label: string,
    relation: 'forks' | 'contradicts' | 'supports',
    reason: string,
  ) =>
    scene('/sharing/respond', {
      space,
      publication,
      node,
      label,
      relation,
      ...(reason === '' ? {} : { reason }),
    }) as Promise<Offered>,
  lineage: (node: string) =>
    scene(`/sharing/lineage?node=${encoded(node)}`) as Promise<{
      steps: readonly LineageStep[]
    }>,
  publicationUpdates: () =>
    scene('/sharing/updates') as Promise<{ updates: readonly PublicationUpdate[] }>,
  keepCited: (newer: string) => scene('/sharing/updates/keep', { newer }),
  model: () => scene('/model') as Promise<ModelInfo>,
  saveModel: (settings: {
    baseUrl: string
    model: string
    apiKey?: string
    reasoningEffort?: string
  }) => scene('/model/settings', settings) as Promise<ModelChange>,
  clearModel: () => scene('/model/clear', {}) as Promise<ModelChange>,
  agents: () =>
    scene('/agents') as Promise<{ agents: readonly AgentInfo[]; others: readonly AgentUse[] }>,
  connectAgent: (id: string) =>
    scene('/agents/connect', { id }) as Promise<{ agent: AgentInfo; said?: string }>,
  disconnectAgent: (id: string) =>
    scene('/agents/disconnect', { id }) as Promise<{ agent: AgentInfo }>,
  addCustomAgent: (agent: CustomAgentRequest) =>
    scene('/agents/custom', agent) as Promise<{ agent: AgentInfo }>,
  removeCustomAgent: (id: string) => scene('/agents/custom/remove', { id }),
  forgetAgentUse: (key: string) => scene('/agents/forget', { key }),
  conversations: (archived: boolean) =>
    scene(`/conversations${archived ? '?archived=1' : ''}`) as Promise<{
      conversations: readonly ConversationInfo[]
    }>,
  updateConversation: (thread: string, change: { title?: string; archived?: boolean }) =>
    scene('/conversations/update', { thread, ...change }),
  agentSessions: (agent: string | undefined, q: string) => {
    const query = new URLSearchParams()
    if (agent !== undefined) query.set('agent', agent)
    if (q !== '') query.set('q', q)
    const shown = query.toString()
    return scene(`/agent-sessions${shown === '' ? '' : `?${shown}`}`) as Promise<{
      agents: readonly { id: string; name: string; found: boolean }[]
      sessions: readonly AgentSessionInfo[]
    }>
  },
  agentSession: (agent: string, id: string) =>
    scene(`/agent-sessions/read?agent=${encoded(agent)}&id=${encoded(id)}`) as Promise<{
      session: AgentSessionDetail
    }>,
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
    scene('/candidates', { space, thread, reply }) as Promise<Offered>,
  candidatesFromTurn: (space: string, thread: string, turn: string) =>
    scene('/candidates/turn', { space, thread, turn }) as Promise<Offered>,
  candidatesFromThread: (space: string, thread: string) =>
    scene('/candidates/thread', { space, thread }) as Promise<Offered>,
  trail: (space: string, node: string) =>
    scene(`/understanding/trail?space=${encoded(space)}&node=${encoded(node)}`) as Promise<{
      trail: readonly TrailEntry[]
    }>,
  revise: (space: string, node: string, label: string, reason: string) =>
    scene('/understanding/revise', {
      space,
      node,
      label,
      ...(reason === '' ? {} : { reason }),
    }) as Promise<Offered>,
  relate: (space: string, from: string, to: string, relation: 'contradicts' | 'supports') =>
    scene('/understanding/relate', { space, from, to, relation }) as Promise<Offered>,
  challenge: (space: string, node: string, text?: string) =>
    scene('/understanding/challenge', {
      space,
      node,
      ...(text === undefined ? {} : { text }),
    }) as Promise<{ challenge?: Challenge; message?: string; failure?: Failure }>,
  settleChallenge: (
    challenge: string,
    status: 'dismissed' | 'conflict' | 'revised',
    extra: { reason?: string; revisedTo?: string },
  ) => scene('/understanding/challenge/settle', { challenge, status, ...extra }),
  // The person's own record of where they stand, through the API's own record route.
  record: (target: string, dimensions: Readonly<Record<string, string>>, reason: string) =>
    request('/record', { target, dimensions, reason }),
  workflows: () =>
    scene('/workflows') as Promise<{
      workflows: readonly WorkflowInfo[]
      blocks: readonly BlockInfo[]
    }>,
  plans: (space: string) =>
    scene(`/plans?space=${encoded(space)}`) as Promise<{ plans: readonly Plan[] }>,
  plan: (id: string) => scene(`/plan?id=${encoded(id)}`) as Promise<PlanDetail>,
  createPlan: (space: string, topic: string, minutes: number, workflow: string) =>
    scene('/plans', { space, topic, minutes, workflow }) as Promise<PlanProposal>,
  updatePlan: (
    plan: string,
    change: { status?: 'active' | 'paused'; steps?: readonly unknown[] },
  ) => scene('/plans/update', { plan, ...change }) as Promise<{ plan: Plan }>,
  act: (plan: string, action: string, text: string | undefined, retry: boolean) =>
    scene('/plans/act', {
      plan,
      action,
      ...(text === undefined ? {} : { text }),
      ...(retry ? { retry } : {}),
    }) as Promise<PlanMove>,
  status: (space: string) => scene(`/status?space=${encoded(space)}`) as Promise<Status>,
  outcomes: (space: string) =>
    scene(`/outcomes?space=${encoded(space)}`) as Promise<{
      objectives: readonly ObjectiveReading[]
      unlinked: number
      sessions: readonly SessionOutcome[]
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
