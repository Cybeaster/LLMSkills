import { build } from 'esbuild'
import { chmodSync, mkdirSync } from 'node:fs'

const banner = {
  js: "#!/usr/bin/env node\nimport { createRequire as __orchRequire } from 'node:module';\nconst require = __orchRequire(import.meta.url);",
}
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  jsx: 'automatic',
  banner,
  external: ['react-devtools-core'],
  logLevel: 'warning',
}

mkdirSync('bin', { recursive: true })
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'bin/orch' })
chmodSync('bin/orch', 0o755)
