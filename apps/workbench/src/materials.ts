import { createHash, randomUUID } from 'node:crypto'
import MiniSearch from 'minisearch'
import type { SceneLog } from '@episteme/application'
import { chunkText, type Chunk, type PageSpan } from './chunk.js'
import type { MaterialKind, ParsedMaterial } from './parse.js'
import { coverage, tokenize } from './tokens.js'

/**
 * The material of each person's spaces, kept in the graph's own file.
 *
 * Material is never understanding: nothing here reaches the graph. Removing a material removes its text from the
 * database, so what a person deleted is gone. Citations an earlier answer made keep their own quotes.
 */

export interface Material {
  readonly id: string
  readonly owner: string
  readonly space: string
  readonly title: string
  readonly kind: MaterialKind
  readonly text: string
  readonly pages?: readonly PageSpan[]
  readonly digest: string
  /** 1, then one more each time its content is replaced. */
  readonly version: number
  readonly addedAt: number
}

/** What a list shows: everything but the text. */
export type MaterialSummary = Omit<Material, 'text' | 'pages' | 'owner'> & {
  readonly characters: number
  readonly chunks: number
}

export interface SearchHit {
  readonly material: Material
  readonly chunk: Chunk
  readonly score: number
  /** How much of the query this passage contains, from 0 to 1. */
  readonly coverage: number
}

const SCHEMA_VERSION = 1
const MAX_HITS_PER_MATERIAL = 3

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

interface IndexedChunk {
  readonly id: string
  readonly text: string
  readonly title: string
  readonly material: string
  readonly chunk: number
}

export class MaterialStore {
  readonly #log: SceneLog
  readonly #materials = new Map<string, Material>()
  /** Built on the first search of a space and dropped whenever its material changes. */
  readonly #indexes = new Map<string, MiniSearch<IndexedChunk>>()
  #tail: Promise<unknown> = Promise.resolve()

  private constructor(log: SceneLog) {
    this.#log = log
  }

  static async open(log: SceneLog): Promise<MaterialStore> {
    const store = new MaterialStore(log)
    for (const [index, body] of (await log.read()).entries()) {
      const record = JSON.parse(body) as { schemaVersion?: unknown; material?: Material }
      if (record.schemaVersion !== SCHEMA_VERSION || record.material === undefined) {
        throw new Error(`record ${index + 1} of the material log is not one this build reads`)
      }
      store.#materials.set(record.material.id, record.material)
    }
    return store
  }

  /** One write at a time, so two uploads of one file cannot both find it absent. */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work)
    this.#tail = run.catch(() => undefined)
    return run
  }

  list(owner: string, space: string): readonly MaterialSummary[] {
    return this.#of(owner, space).map(({ text, pages, owner: _owner, ...summary }) => ({
      ...summary,
      characters: text.length,
      chunks: chunkText(text, pages).length,
    }))
  }

  /** A material of this person's, or `undefined` for any other. */
  get(owner: string, id: string): Material | undefined {
    const material = this.#materials.get(id)
    return material?.owner === owner ? material : undefined
  }

  /** Keeps a material, or finds the one in this space with the same words and keeps nothing new. */
  add(input: {
    readonly owner: string
    readonly space: string
    readonly title: string
    readonly parsed: ParsedMaterial
    readonly at: number
  }): Promise<{ readonly material: Material; readonly duplicate: boolean }> {
    return this.#exclusive(async () => {
      const digest = digestOf(input.parsed.text)
      const same = this.#of(input.owner, input.space).find((kept) => kept.digest === digest)
      if (same !== undefined) return { material: same, duplicate: true }
      const material: Material = {
        id: `mat_${randomUUID()}`,
        owner: input.owner,
        space: input.space,
        title: input.title,
        kind: input.parsed.kind,
        text: input.parsed.text,
        ...(input.parsed.pages === undefined ? {} : { pages: input.parsed.pages }),
        digest,
        version: 1,
        addedAt: input.at,
      }
      await this.#log.append(this.#line(material))
      this.#materials.set(material.id, material)
      this.#indexes.delete(this.#spaceKey(material))
      return { material, duplicate: false }
    })
  }

  /** New content under the same id. The old text leaves the database, and the next search sees only the new. */
  replace(owner: string, id: string, parsed: ParsedMaterial): Promise<Material | undefined> {
    return this.#exclusive(async () => {
      const kept = this.get(owner, id)
      if (kept === undefined) return undefined
      const { pages: _pages, ...rest } = kept
      const material: Material = {
        ...rest,
        kind: parsed.kind,
        text: parsed.text,
        ...(parsed.pages === undefined ? {} : { pages: parsed.pages }),
        digest: digestOf(parsed.text),
        version: kept.version + 1,
      }
      await this.#rewrite(new Map(this.#materials).set(id, material))
      this.#indexes.delete(this.#spaceKey(material))
      return material
    })
  }

  /** Removes a material of this person's. Returns whether there was one. */
  remove(owner: string, id: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const kept = this.get(owner, id)
      if (kept === undefined) return false
      const next = new Map(this.#materials)
      next.delete(id)
      await this.#rewrite(next)
      this.#indexes.delete(this.#spaceKey(kept))
      return true
    })
  }

  /** The passages of a space that best match `query`, best first, each with how much of the query it holds. */
  search(owner: string, space: string, query: string, limit = 6): readonly SearchHit[] {
    const index = this.#indexOf(owner, space)
    const perMaterial = new Map<string, number>()
    const hits: SearchHit[] = []
    const fuzzy = (term: string): number | false => (/^[a-z]{5,}$/.test(term) ? 0.2 : false)
    for (const result of index.search(query, { combineWith: 'OR', fuzzy, boost: { title: 0.5 } })) {
      const materialId = result['material'] as string
      const used = perMaterial.get(materialId) ?? 0
      if (used >= MAX_HITS_PER_MATERIAL) continue
      const material = this.#materials.get(materialId)
      const chunk =
        material === undefined
          ? undefined
          : chunkText(material.text, material.pages)[result['chunk'] as number]
      if (material === undefined || chunk === undefined) continue
      perMaterial.set(materialId, used + 1)
      hits.push({
        material,
        chunk,
        score: result.score,
        coverage: coverage(query, `${material.title}\n${chunk.text}`),
      })
      if (hits.length >= limit) break
    }
    return hits
  }

  #of(owner: string, space: string): readonly Material[] {
    return [...this.#materials.values()].filter(
      (material) => material.owner === owner && material.space === space,
    )
  }

  #spaceKey(material: Pick<Material, 'owner' | 'space'>): string {
    return JSON.stringify([material.owner, material.space])
  }

  #indexOf(owner: string, space: string): MiniSearch<IndexedChunk> {
    const key = this.#spaceKey({ owner, space })
    const existing = this.#indexes.get(key)
    if (existing !== undefined) return existing
    const index = new MiniSearch<IndexedChunk>({
      fields: ['text', 'title'],
      storeFields: ['material', 'chunk'],
      tokenize,
      // `tokenize` has already lowercased and normalized.
      processTerm: (term) => term,
    })
    for (const material of this.#of(owner, space)) {
      index.addAll(
        chunkText(material.text, material.pages).map((chunk) => ({
          id: `${material.id}:${chunk.index}`,
          text: chunk.text,
          title: material.title,
          material: material.id,
          chunk: chunk.index,
        })),
      )
    }
    this.#indexes.set(key, index)
    return index
  }

  #line(material: Material): string {
    return JSON.stringify({ schemaVersion: SCHEMA_VERSION, material })
  }

  /** Written first and kept in memory only once written, so a failed write changes nothing. */
  async #rewrite(next: ReadonlyMap<string, Material>): Promise<void> {
    await this.#log.replace([...next.values()].map((material) => this.#line(material)))
    this.#materials.clear()
    for (const [id, material] of next) this.#materials.set(id, material)
  }
}
