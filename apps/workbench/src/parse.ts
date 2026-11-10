import { canonicalText } from '@episteme/distillation'
import { extractText, getDocumentProxy } from 'unpdf'
import type { PageSpan } from './chunk.js'

/** A material the workbench will not take, with why, as a value the person can act on. */
export class MaterialRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MaterialRefusal'
  }
}

export type MaterialKind = 'text' | 'markdown' | 'pdf'

export interface ParsedMaterial {
  readonly kind: MaterialKind
  /** Canonical; every chunk and citation offset points into it. */
  readonly text: string
  readonly pages?: readonly PageSpan[]
}

/** The largest file taken, before decoding. */
export const MAX_MATERIAL_BYTES = 20 * 1024 * 1024
/** Below this much text per page, a PDF is a scan: extraction found page furniture at most. */
const MIN_CHARACTERS_PER_PAGE = 16

const KINDS: Readonly<Record<string, MaterialKind>> = {
  txt: 'text',
  text: 'text',
  md: 'markdown',
  markdown: 'markdown',
  pdf: 'pdf',
}

function decode(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new MaterialRefusal('not_utf8', '这个文件不是 UTF-8 编码的文本。请先转换编码再上传。')
  }
  if (text.includes('\0')) {
    throw new MaterialRefusal('not_text', '这个文件看起来是二进制文件，不是文本。')
  }
  return canonicalText(text)
}

async function readPdf(bytes: Uint8Array): Promise<ParsedMaterial> {
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new MaterialRefusal('pdf_unreadable', '这个文件不是有效的 PDF。')
  }
  let pageTexts: readonly string[]
  try {
    const document = await getDocumentProxy(new Uint8Array(bytes))
    const { text } = await extractText(document, { mergePages: false })
    pageTexts = text
  } catch (error) {
    if ((error as Error).name === 'PasswordException') {
      throw new MaterialRefusal('pdf_encrypted', '这个 PDF 有密码保护。请解除密码后再上传。')
    }
    throw new MaterialRefusal('pdf_unreadable', '无法读取这个 PDF，文件可能已损坏。')
  }
  const pages: PageSpan[] = []
  let text = ''
  for (const [index, pageText] of pageTexts.entries()) {
    const canonical = canonicalText(pageText).trim()
    if (canonical === '') continue
    const start = text.length
    text += canonical
    pages.push({ page: index + 1, start, end: text.length })
    text += '\n\n'
  }
  if (text.replace(/\s/g, '').length < MIN_CHARACTERS_PER_PAGE * Math.max(pageTexts.length, 1)) {
    if (usesPredefinedCjkCMap(bytes)) {
      throw new MaterialRefusal(
        'pdf_cjk_encoding',
        '这个 PDF 的中日韩文字用了未嵌入的字体编码，目前还读不出来；它不是扫描件。可以在 PDF 阅读器里复制文字，存成 .txt 再上传。',
      )
    }
    throw new MaterialRefusal(
      'pdf_no_text',
      '这个 PDF 里几乎没有可提取的文字，可能是扫描件。目前只支持文本 PDF，请先做 OCR。',
    )
  }
  return { kind: 'pdf', text: text.trimEnd(), pages }
}

/**
 * Whether a font in the file is encoded with one of Adobe's predefined CJK CMaps (`UniGB-UCS2-H`, `GBK-EUC-H`, …).
 *
 * Text in such a font can be read only with the CMap's data, which the extractor does not have, so it comes back
 * empty and would otherwise be called a scan. Read from the raw bytes, so a font dictionary inside a compressed
 * object stream is missed and that file keeps the general refusal.
 */
function usesPredefinedCjkCMap(bytes: Uint8Array): boolean {
  const raw = new TextDecoder('latin1').decode(bytes)
  return /\/Encoding\s*\/(?:Uni(?:GB|CNS|JIS|KS)|GBK|GBpc|GBT|GB-EUC|B5|ETen|HKscs|CNS\d|90ms|90pv|83pv|KSC)[\w-]*-[HV]\b/.test(
    raw,
  )
}

/** Reads an uploaded file into text with its page spans, or refuses it with a reason. */
export async function parseMaterial(fileName: string, bytes: Uint8Array): Promise<ParsedMaterial> {
  const extension = fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : ''
  const kind = KINDS[extension]
  if (kind === undefined) {
    throw new MaterialRefusal('unsupported_type', '目前只支持 .txt、.md 和文本 PDF。')
  }
  if (bytes.length > MAX_MATERIAL_BYTES) {
    throw new MaterialRefusal('too_large', '文件超过 20 MB。请拆分后再上传。')
  }
  if (kind === 'pdf') return readPdf(bytes)
  const text = decode(bytes)
  if (text.trim() === '') throw new MaterialRefusal('empty', '这个文件没有内容。')
  return { kind, text }
}
