import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { tokenizeJapanese } from '../search.mjs'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ siteData }) {
    const search = siteData.value.themeConfig.search
    if (search?.provider !== 'local') return

    search.options ??= {}
    search.options.miniSearch ??= {}
    search.options.miniSearch.options ??= {}
    search.options.miniSearch.options.tokenize = tokenizeJapanese
  }
} satisfies Theme
