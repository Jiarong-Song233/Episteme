/**
 * Material cut into passages that each say where they came from.
 *
 * The approach is the recursive separators of LangChain's text splitter, rewritten because a citation needs character
 * offsets, which that splitter does not give. Chunks are derived from the text and never stored, so a material and its
 * passages cannot disagree.
 */

/** Where a page of a PDF lies in the material's text. */
export interface PageSpan {
  readonly page: number
  readonly start: number
  readonly end: number
}

export interface Chunk {
  /** Its position in the material; stable while the text and `CHUNK_VERSION` are. */
  readonly index: number
  /** `text.slice(start, end)` of the material is exactly this passage. */
  readonly start: number
  readonly end: number
  readonly text: string
  /** The 1-based line it starts on. */
  readonly line: number
  /** The PDF page it starts on, for a material with pages. */
  readonly page?: number
  /** The Markdown heading it falls under, when there is one. */
  readonly section?: string
}

const CHUNK_SIZE = 800
const OVERLAP = 100
/** Most natural place to cut first. A cut is taken only from the later half of a window. */
const SEPARATORS: readonly RegExp[] = [/\n\s*\n/g, /\n/g, /[。！？；.!?;]\s*/g, /[，,、\s]+/g]

function cutPoint(text: string, start: number, limit: number): number {
  const window = text.slice(start, limit)
  const earliest = Math.floor(window.length / 2)
  for (const separator of SEPARATORS) {
    let last = -1
    for (const match of window.matchAll(separator)) {
      const end = match.index + match[0].length
      if (end > earliest) last = end
    }
    if (last !== -1) return start + last
  }
  return limit
}

/** One UTF-16 unit back when `offset` would split a surrogate pair, so no chunk begins or ends in half a character. */
function onCharacter(text: string, offset: number): number {
  const unit = text.charCodeAt(offset)
  return unit >= 0xdc00 && unit <= 0xdfff ? offset - 1 : offset
}

const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm

/** The passages of `text`, in order and covering every non-blank character. */
export function chunkText(text: string, pages?: readonly PageSpan[]): readonly Chunk[] {
  const headings = [...text.matchAll(HEADING)].map((match) => ({
    at: match.index,
    title: match[1] ?? '',
  }))
  const lineStarts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1)
  }
  const chunks: Chunk[] = []
  let line = 0
  let start = 0
  while (start < text.length) {
    const limit = start + CHUNK_SIZE
    const end = limit >= text.length ? text.length : onCharacter(text, cutPoint(text, start, limit))
    const raw = text.slice(start, end)
    const leading = raw.length - raw.trimStart().length
    const passage = raw.trim()
    if (passage !== '') {
      const at = start + leading
      while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? 0) <= at) line += 1
      const page = pages?.find((candidate) => at >= candidate.start && at < candidate.end)?.page
      const section = headings.findLast((heading) => heading.at <= at)?.title
      chunks.push({
        index: chunks.length,
        start: at,
        end: at + passage.length,
        text: passage,
        line: line + 1,
        ...(page === undefined ? {} : { page }),
        ...(section === undefined ? {} : { section }),
      })
    }
    if (end >= text.length) break
    // Always forward, however short the cut was.
    start = Math.max(start + 1, onCharacter(text, end - OVERLAP))
    // A line that begins at or before the new start was counted already; a step back must not skip one.
    while (line > 0 && (lineStarts[line] ?? 0) > start) line -= 1
  }
  return chunks
}
