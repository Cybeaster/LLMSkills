export class OrchError extends Error {
  override name = 'OrchError'

  constructor(message: string, readonly code = 1) {
    super(message)
  }
}
