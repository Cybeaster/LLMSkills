import { describeFailure, run } from './cli.js'
import { realCtx } from './ctx.js'

const argv = process.argv.slice(2)
try {
  if (argv[0] === 'tui' && !argv.some(a => a === '--help' || a === '-h')) {
    const tui = new URL('../lib/orch-tui.mjs', import.meta.url).href
    const { startTui } = await import(tui)
    await startTui(realCtx())
  } else {
    const out = await run(argv, realCtx())
    process.stdout.write(out.stdout)
    process.stderr.write(out.stderr)
    process.exitCode = out.code
  }
} catch (e) {
  process.stderr.write(describeFailure(e))
  process.exitCode = 1
}
