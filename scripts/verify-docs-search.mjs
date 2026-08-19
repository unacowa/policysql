import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import MiniSearch from 'minisearch'
import { tokenizeJapanese } from '../website/.vitepress/search.mjs'

const chunksDirectory = new URL('../website/.vitepress/dist/assets/chunks/', import.meta.url)
const chunkName = (await readdir(chunksDirectory)).find((name) =>
  name.startsWith('@localSearchIndexroot.') && name.endsWith('.js')
)

assert.ok(chunkName, 'built local-search index was not found')

const { default: serializedIndex } = await import(
  `${pathToFileURL(new URL(chunkName, chunksDirectory).pathname).href}?verify=${Date.now()}`
)
const search = MiniSearch.loadJSON(serializedIndex, {
  fields: ['title', 'titles', 'text'],
  storeFields: ['title', 'titles'],
  tokenize: tokenizeJapanese,
  searchOptions: {
    fuzzy: 0.2,
    prefix: true,
    boost: { title: 4, text: 2, titles: 1 }
  }
})

for (const query of ['認証サービス', 'ポリシーファイル', 'データ正常性']) {
  assert.ok(search.search(query).length > 0, `no documentation result for: ${query}`)
}

console.log('Japanese documentation search verified')
