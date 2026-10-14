export class OrchError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message)
  }
}
