import type { SceneRoute } from '@episteme/service'
import {
  AgentFailure,
  ENTRY_STYLES,
  SERVER_KEYS,
  type Agents,
  type EntryStyle,
  type ServerKey,
} from './agents.js'
import { refuse, text } from './requests.js'

/**
 * Connecting the agents of this computer. Every route is the person's: reading is in WORKBENCH_PRIVATE_ROUTES, and
 * no `POST` here is a proposing route, so an agent's credential can neither list nor change another agent's settings.
 */
export function agentRoutes(agents: Agents): readonly SceneRoute[] {
  const refusing = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      if (error instanceof AgentFailure) refuse(error.code, error.message)
      throw error
    }
  }
  const id = (body: Readonly<Record<string, unknown>>): string => text(body, 'id', 100)
  const optional = (body: Readonly<Record<string, unknown>>, field: string): string | undefined => {
    const value = body[field]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string' || value.length > 1000)
      refuse('invalid_request', `"${field}" must be a string`)
    return value.trim()
  }

  return [
    { method: 'GET', path: '/agents', handle: () => agents.list() },
    {
      method: 'POST',
      path: '/agents/connect',
      handle: ({ body }) => refusing(() => agents.connect(id(body))),
    },
    {
      method: 'POST',
      path: '/agents/disconnect',
      handle: ({ body }) => refusing(() => agents.disconnect(id(body))),
    },
    {
      method: 'POST',
      path: '/agents/custom',
      handle: ({ body }) =>
        refusing(() => {
          const file = optional(body, 'file')
          const key = optional(body, 'key')
          const style = optional(body, 'style')
          if (key !== undefined && !(SERVER_KEYS as readonly string[]).includes(key)) {
            refuse('invalid_request', '不认识这个列表名。')
          }
          if (style !== undefined && !(ENTRY_STYLES as readonly string[]).includes(style)) {
            refuse('invalid_request', '不认识这种写法。')
          }
          return agents.addCustom({
            name: text(body, 'name', 60),
            ...(file === undefined ? {} : { file }),
            ...(key === undefined ? {} : { key: key as ServerKey }),
            ...(style === undefined ? {} : { style: style as EntryStyle }),
          })
        }),
    },
    {
      method: 'POST',
      path: '/agents/custom/remove',
      handle: ({ body }) =>
        refusing(async () => {
          await agents.removeCustom(id(body))
          return { removed: true }
        }),
    },
    {
      method: 'POST',
      path: '/agents/plugins',
      handle: ({ body }) => refusing(() => agents.importPlugin(text(body, 'manifest', 20_000))),
    },
    {
      method: 'POST',
      path: '/agents/plugins/remove',
      handle: ({ body }) =>
        refusing(async () => {
          await agents.removePlugin(id(body))
          return { removed: true }
        }),
    },
    {
      method: 'POST',
      path: '/agents/forget',
      handle: ({ body }) =>
        refusing(async () => {
          await agents.forget(text(body, 'key', 300))
          return { forgotten: true }
        }),
    },
  ]
}
