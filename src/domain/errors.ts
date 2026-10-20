export type DeskErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid'
  | 'conflict'
  | 'rule'

const STATUS: Record<DeskErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid: 400,
  conflict: 409,
  rule: 422,
}

/** An error whose message is safe to show a client or an agent. */
export class DeskError extends Error {
  readonly status: number
  constructor(
    readonly code: DeskErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DeskError'
    this.status = STATUS[code]
  }
}

export const notFound = (what: string) => new DeskError('not_found', `${what} not found`)
/** A retainer rule from the Retainer page said no. */
export const ruleBroken = (message: string) => new DeskError('rule', message)
