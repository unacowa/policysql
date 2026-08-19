const fallbackSeparator = /[\n\r\p{Z}\p{P}]+/u

/**
 * Split Japanese text into words for both index construction and browser queries.
 * VitePress uses the same function in both places, so serialized MiniSearch data
 * and query-time terms remain compatible.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeJapanese(text) {
  if (typeof Intl.Segmenter !== 'function') {
    return text.toLocaleLowerCase('ja-JP').split(fallbackSeparator).filter(Boolean)
  }

  const segmenter = new Intl.Segmenter('ja-JP', { granularity: 'word' })
  return Array.from(segmenter.segment(text))
    .filter((part) => part.isWordLike)
    .map((part) => part.segment.toLocaleLowerCase('ja-JP'))
}
