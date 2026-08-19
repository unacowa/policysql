import { defineConfig } from 'vitepress'
import { tokenizeJapanese } from './search.mjs'

const base = process.env.DOCS_BASE || '/'

export default defineConfig({
  lang: 'ja-JP',
  title: 'PolicySQL Docs',
  description: 'PolicySQL 利用者ガイド',
  base,
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['README.md'],
  head: [
    ['meta', { name: 'theme-color', content: '#0f6b4f' }],
    ['meta', { name: 'color-scheme', content: 'light dark' }]
  ],
  themeConfig: {
    siteTitle: 'PolicySQL',
    logo: {
      light: '/brand-mark.svg',
      dark: '/brand-mark-dark.svg',
      alt: 'PolicySQL'
    },
    nav: [
      { text: 'ガイド', link: '/guide/getting-started' },
      { text: 'SQL', link: '/sql/select' },
      { text: 'データ正常性', link: '/data-validity/overview' },
      { text: 'API', link: '/api/execute' },
      { text: 'Clients', link: '/clients/kysely' },
      { text: 'ポリシー管理', link: '/admin/policies' },
      { text: 'リファレンス', link: '/reference/limitations' }
    ],
    sidebar: [
      {
        text: 'はじめに',
        items: [
          { text: 'PolicySQLとは', link: '/' },
          { text: 'クイックスタート', link: '/guide/getting-started' },
          { text: '基本概念', link: '/guide/concepts' }
        ]
      },
      {
        text: 'SQLを使う',
        items: [
          { text: 'SELECT', link: '/sql/select' },
          { text: '追加・更新・削除', link: '/sql/mutations' },
          { text: 'SQLパラメータ', link: '/sql/parameters' }
        ]
      },
      {
        text: 'データ正常性',
        items: [
          { text: '全体像', link: '/data-validity/overview' },
          { text: '型・フォーマット・制約', link: '/data-validity/types-and-formats' },
          { text: '書き込みの整合性', link: '/sql/write-integrity' },
          { text: 'Commit check', link: '/sql/commit-checks' }
        ]
      },
      {
        text: '認証と認可',
        items: [
          { text: 'JWT認証', link: '/security/jwt' },
          { text: '認証とポリシー', link: '/security/auth-and-policy' }
        ]
      },
      {
        text: 'HTTP API',
        items: [
          { text: 'Atomic Execute', link: '/api/execute' },
          { text: '対話型Transaction', link: '/api/transactions' },
          { text: 'Explain', link: '/api/explain' },
          { text: 'エラー', link: '/api/errors' }
        ]
      },
      {
        text: 'Clients',
        items: [
          { text: 'Kysely client', link: '/clients/kysely' },
          { text: 'TypeScript型生成', link: '/clients/type-generation' },
          { text: 'Client開発ガイド', link: '/clients/driver-development' }
        ]
      },
      {
        text: '管理',
        items: [
          { text: 'ポリシー管理', link: '/admin/policies' },
          { text: 'CatalogとCapabilities', link: '/reference/catalog-and-capabilities' }
        ]
      },
      {
        text: 'リファレンス',
        items: [
          { text: '制限事項', link: '/reference/limitations' },
          { text: 'HTTP共通仕様', link: '/reference/http-conventions' },
          { text: '実践例', link: '/examples/author-posts' },
          { text: '用語集', link: '/reference/glossary' }
        ]
      }
    ],
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          options: {
            tokenize: tokenizeJapanese
          }
        },
        translations: {
          button: { buttonText: '検索', buttonAriaLabel: 'ドキュメントを検索' },
          modal: {
            noResultsText: '該当するページがありません',
            resetButtonTitle: '検索をリセット',
            footer: {
              selectText: '選択',
              navigateText: '移動',
              closeText: '閉じる'
            }
          }
        }
      }
    },
    outline: { level: [2, 3], label: 'このページ' },
    docFooter: { prev: '前のページ', next: '次のページ' },
    lastUpdated: { text: '最終更新' },
    skipToContentLabel: '本文へ移動',
    navScreenMenuLabel: 'メニュー',
    returnToTopLabel: 'ページ上部へ戻る',
    sidebarMenuLabel: 'メニュー',
    darkModeSwitchLabel: '表示テーマ',
    lightModeSwitchTitle: 'ライトテーマに切り替える',
    darkModeSwitchTitle: 'ダークテーマに切り替える',
    footer: {
      message: 'Released under the MIT or Apache-2.0 License.',
      copyright: 'PolicySQL contributors'
    }
  }
})
