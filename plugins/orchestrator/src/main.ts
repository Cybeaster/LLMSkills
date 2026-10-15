import { describeFailure, run } from './cli.js'
import { realCtx } from './ctx.js'

try {
  const out = await run(process.argv.slice(2), realCtx())
  process.stdout.write(out.stdout)
  process.stderr.write(out.stderr)
  process.exitCode = out.code
} catch (e) {
  process.stderr.write(describeFailure(e))
  process.exitCode = 1
}
