/**
 * What a Source shares when the agent acts under a person's own account (GitLab `personal`, Feishu Project): the words of a
 * message a person reads as their own, whether a line addresses the agent by its trigger word, and an invisible marker that
 * survives servers which strip HTML comments.
 */
import { escapeRegExp } from '../infra/text.ts'

/**
 * The text of a message a person reads as their own words: without fenced code (``` and ~~~), GitLab's `>>>` quote blocks, `>`
 * quotes and the lines that continue them, HTML comments, `<details>` blocks, indented code and inline code.
 */
export function ownWords(text: string): string {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<details[\s\S]*?<\/details>/gi, '')
  const lines: string[] = []
  let fence: string | undefined
  let quoteBlock = false
  let quoted = false
  for (const line of stripped.split(/\r?\n/)) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) { if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && !line.trim().slice(open[1]!.length).trim()) fence = undefined; continue }
    if (open) { fence = open[1]; continue }
    if (/^ {0,3}>>>\s*$/.test(line)) { quoteBlock = !quoteBlock; continue }
    if (quoteBlock) continue
    if (/^ {0,3}>/.test(line)) { quoted = true; continue }
    // A line right after a quote, with no blank line between, continues it.
    if (quoted && line.trim()) continue
    quoted = false
    if (/^( {4,}|\t)/.test(line)) continue
    lines.push(line.replace(/(`+)[\s\S]*?\1/g, ''))
  }
  return lines.join('\n')
}
/**
 * True when a line of `text` addresses the agent by `trigger`: at the line's start (at most three spaces in), after any
 * mentions each followed by a separator, the word and a colon (`:` or `：`), in any case. Quotes and code do not count.
 * `normalize` rewrites a Source's own mention syntax into `@name` tokens before the match (see `meegoMentions`).
 */
export function summons(text: string, trigger: string, normalize: (text: string) => string = text => text): boolean {
  if (!trigger) return false
  const mention = '@[\\w.\\-]+(?![\\w.\\-])[\\s,，、]+'
  const line = new RegExp(`^ {0,3}(?:${mention})*${escapeRegExp(trigger)}\\s*[:：]`, 'i')
  return ownWords(normalize(text)).split('\n').some(item => line.test(item))
}

/** Han characters without kana read as Chinese; anything else as English, as the end notices choose. */
export const chinese = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)

/** Bits of an invisible marker; 64 of them name a message well enough, and stay short in the text. */
export const MARKER_BITS = 64
const ZERO = '\u200b', ONE = '\u200c', EDGE = '\u2060'
/** `bits` (a string of `0` and `1`) as zero-width characters between word joiners, invisible on any page that keeps them. */
export const invisibleMarker = (bits: string): string => `${EDGE}${[...bits].map(bit => bit === '1' ? ONE : ZERO).join('')}${EDGE}`
/** The bits of every invisible marker in `text`, in order. */
export function invisibleMarkers(text: string): string[] {
  const pattern = new RegExp(`${EDGE}([${ZERO}${ONE}]{${MARKER_BITS}})${EDGE}`, 'g')
  return [...text.matchAll(pattern)].map(match => [...match[1]!].map(char => char === ONE ? '1' : '0').join(''))
}
/** The `MARKER_BITS` bits a message id names, taken from its hex digest (`key`). */
export function markerBits(hex: string): string {
  const bits = [...hex].map(digit => parseInt(digit, 16).toString(2).padStart(4, '0')).join('')
  if (bits.length < MARKER_BITS || /[^01]/.test(bits)) throw new Error('A marker needs a hex digest of at least 16 digits')
  return bits.slice(0, MARKER_BITS)
}
/** `text` without zero-width markers, as a person reads it. */
export const withoutMarkers = (text: string): string => text.replace(new RegExp(`${EDGE}[${ZERO}${ONE}]*${EDGE}`, 'g'), '')
