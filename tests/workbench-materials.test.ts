import { CognitiveSession } from '@episteme/application'
import {
  chunkText,
  coverage,
  MaterialRefusal,
  MaterialStore,
  parseMaterial,
  tokenize,
} from '@episteme/workbench'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A minimal, valid PDF with one line of text on each page, so a test needs no binary fixture. */
function pdfOf(pages: readonly string[]): Uint8Array {
  const objects: string[] = []
  const pageIds = pages.map((_, index) => 3 + index * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  const font = 3 + pages.length * 2
  pages.forEach((text, index) => {
    const page = 3 + index * 2
    const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`
    objects[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`
    objects[page + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  objects[font] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return bytes(body)
}

async function refusalOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(MaterialRefusal)
  return (error as MaterialRefusal).code
}

async function storeInMemory(): Promise<MaterialStore> {
  const session = await CognitiveSession.open()
  return MaterialStore.open(session.sceneLog('materials'))
}

const added = (store: MaterialStore, space: string, title: string, text: string) =>
  store.add({ owner: 'a', space, title, parsed: { kind: 'text', text }, at: 1 })

describe('tokens', () => {
  it('finds Chinese words and pairs, and drops words that say nothing', () => {
    const tokens = tokenize('什么是位置编码？')
    expect(tokens).toContain('位置')
    expect(tokens).toContain('编码')
    expect(tokens).not.toContain('什么')
    expect(tokenize('the Attention of it')).toEqual(['attention'])
  })

  it('measures how much of a question a passage holds', () => {
    expect(coverage('位置编码', '位置编码把顺序告诉模型')).toBe(1)
    expect(coverage('光合作用', '位置编码把顺序告诉模型')).toBe(0)
    expect(coverage('的了吗', '的了吗')).toBe(0)
  })
})

describe('chunks', () => {
  it('points exactly at its text, and covers the material', () => {
    const text = Array.from(
      { length: 120 },
      (_, index) => `第 ${index} 句话讲一件事。This is sentence ${index}.`,
    ).join('\n')
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text)
      expect(chunk.text.length).toBeLessThanOrEqual(800)
      expect(text.split('\n')[chunk.line - 1]).toContain(chunk.text.split('\n')[0]?.slice(0, 4))
    }
    expect(chunks[0]?.start).toBe(0)
    expect(chunks.at(-1)?.end).toBe(text.length)
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index]!.start).toBeLessThanOrEqual(chunks[index - 1]!.end)
    }
  })

  it('never splits a character outside the basic plane', () => {
    const text = '𠮷'.repeat(2000)
    for (const chunk of chunkText(text)) {
      expect(chunk.text).toBe('𠮷'.repeat(chunk.text.length / 2))
    }
  })

  it('names the Markdown section and the PDF page', () => {
    const long = `intro\n\n# 第一章\n\n${'正文。'.repeat(400)}\n\n# 第二章\n\n${'后文。'.repeat(400)}`
    const sections = chunkText(long).map((chunk) => chunk.section)
    expect(sections[0]).toBeUndefined()
    expect(sections).toContain('第一章')
    expect(sections.at(-1)).toBe('第二章')
    const chunks = chunkText('page one text', [{ page: 3, start: 0, end: 13 }])
    expect(chunks[0]?.page).toBe(3)
  })

  it('finishes on text with no place to cut', () => {
    const chunks = chunkText('x'.repeat(5000))
    expect(chunks.at(-1)?.end).toBe(5000)
    expect(chunks.length).toBeLessThan(10)
  })
})

describe('parsing', () => {
  it('reads text and Markdown, and normalizes line ends', async () => {
    expect(await parseMaterial('a.txt', bytes('一\r\n二'))).toMatchObject({
      kind: 'text',
      text: '一\n二',
    })
    expect((await parseMaterial('a.MD', bytes('# 标题'))).kind).toBe('markdown')
  })

  it('reads a text PDF page by page', async () => {
    const parsed = await parseMaterial(
      'a.pdf',
      pdfOf(['Attention mixes tokens without any order.', 'Positional encoding adds the order.']),
    )
    expect(parsed.kind).toBe('pdf')
    expect(parsed.pages?.map((page) => page.page)).toEqual([1, 2])
    const second = parsed.pages![1]!
    expect(parsed.text.slice(second.start, second.end)).toContain('Positional encoding')
    const chunk = chunkText(parsed.text, parsed.pages)[0]
    expect(chunk?.page).toBe(1)
  })

  it('refuses what it cannot read, each with its own reason', async () => {
    expect(await refusalOf(parseMaterial('a.docx', bytes('x')))).toBe('unsupported_type')
    expect(await refusalOf(parseMaterial('noext', bytes('x')))).toBe('unsupported_type')
    expect(await refusalOf(parseMaterial('a.txt', bytes('  \n ')))).toBe('empty')
    expect(await refusalOf(parseMaterial('a.txt', new Uint8Array([0xff, 0xfe, 0x00])))).toBe(
      'not_utf8',
    )
    expect(await refusalOf(parseMaterial('a.txt', new Uint8Array([0x41, 0x00, 0x42])))).toBe(
      'not_text',
    )
    expect(await refusalOf(parseMaterial('a.pdf', bytes('not a pdf')))).toBe('pdf_unreadable')
    expect(await refusalOf(parseMaterial('a.pdf', bytes('%PDF-1.4 garbage')))).toBe(
      'pdf_unreadable',
    )
    expect(await refusalOf(parseMaterial('a.pdf', pdfOf([''])))).toBe('pdf_no_text')
    expect(await refusalOf(parseMaterial('a.txt', new Uint8Array(20 * 1024 * 1024 + 1)))).toBe(
      'too_large',
    )
  })
})

describe('the material store', () => {
  it('keeps the same words once per space, and again in another', async () => {
    const store = await storeInMemory()
    const first = await added(store, 's1', 'one', '位置编码')
    expect(first.duplicate).toBe(false)
    expect((await added(store, 's1', 'again', '位置编码')).material.id).toBe(first.material.id)
    expect((await added(store, 's1', 'again', '位置编码')).duplicate).toBe(true)
    expect((await added(store, 's2', 'other', '位置编码')).duplicate).toBe(false)
  })

  it('does not keep the same upload twice when two arrive together', async () => {
    const store = await storeInMemory()
    const [left, right] = await Promise.all([
      added(store, 's', 'one', '同一段'),
      added(store, 's', 'two', '同一段'),
    ])
    expect(left.material.id).toBe(right.material.id)
    expect(store.list('a', 's')).toHaveLength(1)
  })

  it('searches Chinese and English, and across documents', async () => {
    const store = await storeInMemory()
    await added(store, 's', '编码', '位置编码把序列的顺序告诉模型。')
    await added(store, 's', 'attention', 'Self-attention mixes tokens with no sense of order.')
    await added(store, 's', '无关', '光合作用发生在叶绿体中。')
    const chinese = store.search('a', 's', '位置编码是做什么的')
    expect(chinese[0]?.material.title).toBe('编码')
    expect(chinese[0]?.coverage).toBeGreaterThan(0.5)
    expect(store.search('a', 's', 'attention tokens')[0]?.material.title).toBe('attention')
    const both = store.search('a', 's', '位置编码 attention').map((hit) => hit.material.title)
    expect(both).toEqual(expect.arrayContaining(['编码', 'attention']))
    expect(store.search('a', 's', '量子纠缠')).toEqual([])
  })

  it('keeps people and spaces apart', async () => {
    const store = await storeInMemory()
    const { material } = await added(store, 's1', 'one', '位置编码')
    expect(store.search('a', 's2', '位置编码')).toEqual([])
    expect(store.search('b', 's1', '位置编码')).toEqual([])
    expect(store.get('b', material.id)).toBeUndefined()
    expect(await store.remove('b', material.id)).toBe(false)
    expect(store.list('b', 's1')).toEqual([])
    expect(store.list('a', 's1')).toHaveLength(1)
  })

  it('stops finding what was removed or replaced, and allows it again', async () => {
    const store = await storeInMemory()
    const { material } = await added(store, 's', 'one', '位置编码')
    expect(store.search('a', 's', '位置编码')).toHaveLength(1)
    const next = await store.replace('a', material.id, { kind: 'text', text: '注意力机制' })
    expect(next?.version).toBe(2)
    expect(store.search('a', 's', '位置编码')).toEqual([])
    expect(store.search('a', 's', '注意力')).toHaveLength(1)
    expect(await store.remove('a', material.id)).toBe(true)
    expect(store.search('a', 's', '注意力')).toEqual([])
    expect(store.list('a', 's')).toEqual([])
    expect((await added(store, 's', 'back', '注意力机制')).duplicate).toBe(false)
  })

  it('survives a restart, and what was deleted leaves the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'episteme-workbench-'))
    const path = join(directory, 'graph.db')
    try {
      const first = await CognitiveSession.open({ filePath: path })
      const store = await MaterialStore.open(first.sceneLog('materials'))
      await added(store, 's', 'kept', '保留的位置编码')
      const gone = await added(store, 's', 'gone', '要删除的秘密内容')
      await store.remove('a', gone.material.id)
      await first.close()

      const second = await CognitiveSession.open({ filePath: path })
      const log = second.sceneLog('materials')
      expect((await log.read()).join('\n')).not.toContain('秘密')
      const reopened = await MaterialStore.open(log)
      expect(reopened.list('a', 's').map((material) => material.title)).toEqual(['kept'])
      expect(reopened.search('a', 's', '位置编码')).toHaveLength(1)
      await second.close()
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('refuses a log it cannot read rather than skipping it', async () => {
    const session = await CognitiveSession.open()
    const log = session.sceneLog('materials')
    await log.append('{"schemaVersion":99}')
    await expect(MaterialStore.open(log)).rejects.toThrow(/material log/)
  })
})
