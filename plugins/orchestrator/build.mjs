import { build } from 'esbuild'
import { chmodSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('.', import.meta.url)))

const banner = {
  js: "#!/usr/bin/env node\nimport { createRequire as __orchRequire } from 'node:module';\nconst require = __orchRequire(import.meta.url);",
}

// Ink imports react-devtools-core only when DEV=true; as an external it would be hoisted to a
// top-level import and crash the ESM bundle at load, so it is stubbed instead.
const stubDevtools = {
  name: 'stub-react-devtools-core',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'orch-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'orch-stub' }, () => ({ contents: 'export default { initialize() {}, connectToDevTools() {} }', loader: 'js' }))
  },
}

// esbuild captures process.cwd() when it is imported, before the chdir above runs, so pin it here.
const common = {
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  jsx: 'automatic',
  banner,
  plugins: [stubDevtools],
  logLevel: 'warning',
}

mkdirSync('bin', { recursive: true })
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'bin/orch' })
chmodSync('bin/orch', 0o755)
