/**
 * The words a text is searched by, in Chinese and in English alike.
 *
 * `Intl.Segmenter` finds Chinese words with no dictionary of ours and no native module. It may cut a question and a
 * passage differently, so a longer Chinese word also yields its character pairs, which still meet.
 */

const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' })
const CJK = /^[㐀-鿿]+$/u

/** Words that say nothing about what a passage is about, so a question made of them matches nothing. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'the a an of to in on at is are was were be been it its this that these those and or but if then for with as by ' +
    'from what which who whom how why when where do does did can could should would will i you he she they we me my ' +
    'your about into than there here not no so such ' +
    '的 了 和 与 及 或 是 在 有 就 都 而 也 很 吗 呢 吧 啊 着 过 把 被 对 从 到 为 以 于 之 其 这 那 这个 那个 这些 那些 ' +
    '什么 怎么 怎样 为什么 如何 哪些 哪个 是否 可以 能够 一个 一些 我 你 他 她 它 我们 你们 他们 请问 告诉 一下'
  ).split(' '),
)

/** The searchable words of `text`, lowercased, in order, with repeats. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const { segment, isWordLike } of SEGMENTER.segment(text.normalize('NFKC').toLowerCase())) {
    if (isWordLike !== true || STOP_WORDS.has(segment)) continue
    if (CJK.test(segment) && segment.length > 2) {
      for (let index = 0; index + 2 <= segment.length; index += 1) {
        tokens.push(segment.slice(index, index + 2))
      }
    }
    tokens.push(segment)
  }
  return tokens
}

/** How many of `query`'s distinct words appear in `text`, from 0 to 1; 0 for a query with no words. */
export function coverage(query: string, text: string): number {
  const wanted = new Set(tokenize(query))
  if (wanted.size === 0) return 0
  const present = new Set(tokenize(text))
  let found = 0
  for (const word of wanted) if (present.has(word)) found += 1
  return found / wanted.size
}
