import { run } from './cli.js'
import { realCtx } from './ctx.js'

const out = await run(process.argv.slice(2), realCtx())
process.stdout.write(out.stdout)
process.stderr.write(out.stderr)
process.exitCode = out.code
