import type { SceneView } from '@episteme/application'
import { SessionRefusal } from '@episteme/application'

/** What every workbench route needs to read a request and refuse it. */

export interface Space {
  readonly id: string
  readonly name: string
  readonly archived: boolean
  readonly createdAt: number
}

export const SPACE_PREFIX = 'space/'
export const ANSWER_PREFIX = 'answer/'

export function refuse(code: string, message: string): never {
  throw new SessionRefusal(code, message)
}

export function text(body: Readonly<Record<string, unknown>>, field: string, max = 4096): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    refuse('invalid_request', `"${field}" must be a non-empty string`)
  }
  if (value.length > max) refuse('invalid_request', `"${field}" is longer than ${max} characters`)
  return value
}

export function required(query: URLSearchParams, field: string): string {
  const value = query.get(field)
  if (value === null || value === '') refuse('invalid_request', `"${field}" is required`)
  return value
}

/** The scope every thread, suggestion and accepted node of a space carries. */
export function scopeOf(space: string): string {
  return `workbench:${space}`
}

export function spaceOf(view: SceneView, id: string): Space {
  const record = view.records.get(`${SPACE_PREFIX}${id}`)
  if (record === undefined) refuse('unknown_space', '这个空间不存在。')
  return record.value as Space
}

export function openSpaceOf(view: SceneView, id: string): Space {
  const space = spaceOf(view, id)
  if (space.archived) refuse('space_archived', '这个空间已归档。请先恢复它。')
  return space
}
