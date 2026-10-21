export type Fs = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
}

export const logPath = (home: string, now: Date, sid: string) =>
  `${home}/.claude/state/routing/${now.toISOString().slice(0, 10)}-${sid}.jsonl`

// $.fs has no append: rows go through one queue so two hooks never read-modify-write the file at once
export function makeLogger(fs: Fs, path: () => Promise<string>) {
  let queue = Promise.resolve()
  return (row: object): Promise<void> => {
    queue = queue
      .then(async () => {
        const p = await path()
        const prev = (await fs.exists(p)) ? await fs.read(p) : ''
        await fs.write(p, prev + JSON.stringify(row) + '\n')
      })
      .catch(() => {})
    return queue
  }
}
