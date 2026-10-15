export type Out = { code: number; stdout: string; stderr: string }

export const ok = (stdout = ''): Out => ({ code: 0, stdout, stderr: '' })
