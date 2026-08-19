# PolicySQL documentation site

The user documentation is built with [VitePress](https://vitepress.dev/) and published as static HTML.

## Local development

```sh
npm install
npm run docs:dev
```

## Production build

```sh
npm ci
npm run docs:build
```

The generated site is written to `website/.vitepress/dist`.

Set `DOCS_BASE` when publishing below a subpath:

```sh
DOCS_BASE=/policy-sql/ npm run docs:build
```

GitHub Pages deployment is configured in `.github/workflows/docs.yml`. Enable GitHub Actions as the Pages source in the repository settings before the first deployment.
