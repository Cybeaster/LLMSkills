import { homedir } from 'node:os'
import type { Row } from './overview.js'
import { pad } from './width.js'

export type Line = { row: Row; prefix: string }

export function flatten(rows: Row[]): Line[] {
  const out: Line[] = []
  const walk = (rs: Row[], indent: string, nested: boolean) =>
    rs.forEach((r, i) => {
      const last = i === rs.length - 1
      out.push({ row: r, prefix: nested ? `${indent}${last ? '└ ' : '├ '}` : '' })
      walk(r.children, nested ? `${indent}${last ? '  ' : '│ '}` : '', true)
    })
  walk(rows, '', false)
  return out
}

// Only the start of a path can be the home directory, so /mnt/home/u/src/x is left alone.
export function shortCwd(cwd: string, home = homedir()): string {
  const src = `${home}/src/`
  const short = cwd === home ? '~' : cwd.startsWith(src) ? cwd.slice(src.length) : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
  return short.replace('/.worktrees/', '/wt/')
}

export function listLine({ row, prefix }: Line): string {
  const progress = row.unreadable
    ? 'unreadable pool'
    : row.hasPool
      ? `${row.done}/${row.total}${row.complete ? ' ✓' : ''}`
      : '—  no pool'
  const flags = row.flags ? `  ⚑${row.flags}` : ''
  const orphan = row.orphan ? '  orphan' : ''
  return `${pad(prefix + row.name, 24)} ${pad(shortCwd(row.cwd), 22)} ${pad(row.state, 7)} ${pad(row.tag, 9)} ${progress}${flags}${orphan}`
}

export function header(rows: Row[]): string {
  const all = flatten(rows).map(l => l.row)
  const live = all.filter(r => r.state !== 'ended').length
  const flags = rows.reduce((n, r) => n + r.flags, 0)
  return `ORCHESTRATOR  ${live} live · ${flags} ⚑ · ${all.length - live} ended`
}

export function renderList(rows: Row[]): string {
  const lines = flatten(rows).map(l => {
    const link = l.row.link ? `\n${' '.repeat(l.prefix.length + 2)}→ ${l.row.link}` : ''
    return listLine(l) + link
  })
  return [header(rows), ...lines].join('\n') + '\n'
}

export function poolLines(row: Row): string[] {
  const head = row.title && row.title !== row.name ? `${row.name} — ${row.title}` : row.name
  if (row.unreadable) return [head, `unreadable pool: ${row.unreadable}`]
  if (!row.tasks.length) return [head, '(no pool yet)']
  return [head, ...row.tasks.map(t => `${t.mark} ${t.id.padEnd(4)} ${pad(t.text, 34)} ${t.detail}`.trimEnd())]
}

export const renderPool = (row: Row) => poolLines(row).join('\n') + '\n'
