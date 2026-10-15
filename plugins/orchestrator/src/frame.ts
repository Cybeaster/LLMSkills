import { oneLine } from './evidence.js'

// The prefix orch reply puts before an answer, and the one place that knows its shape: the question on one
// line, at most 200 code points, JSON-quoted. The prompt-submit hook finds it again to see which question was answered.
export const frameQuestion = (question: string): string => `[orch reply to: ${JSON.stringify(Array.from(oneLine(question)).slice(0, 200).join(''))}]`

const FRAME = /\[orch reply to: "(?:[^"\\]|\\.)*"\]/

// The first frame anywhere in a prompt (a relay such as SendMessage may add text in front), or undefined.
export const findFrame = (prompt: string): string | undefined => FRAME.exec(prompt)?.[0]
