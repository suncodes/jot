// 统一的调用结果与错误码。见 docs/architecture.md。

export const ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'VAULT_NOT_OPEN',
  'PATH_OUTSIDE_VAULT',
  'WRITE_DENIED',
  'CONFLICT',
  'IO_ERROR',
  'LLM_NOT_CONFIGURED',
  'LLM_UNAVAILABLE',
  'LLM_BAD_OUTPUT',
  'LLM_CONTEXT_LIMIT',
  'LLM_REASONING_UNSUPPORTED',
  'UNSUPPORTED_FORMAT',
  'CANCELLED',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorInfo {
  code: ErrorCode
  message: string
  detail?: unknown
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorInfo }

export const ok = <T>(data: T): Result<T> => ({ ok: true, data })
export const err = (code: ErrorCode, message: string, detail?: unknown): Result<never> => ({
  ok: false,
  error: { code, message, detail },
})

/** 主进程内部用来抛出业务错误，IPC 层统一转成 Result。 */
export class JotError extends Error {
  readonly code: ErrorCode
  readonly detail?: unknown

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'JotError'
    this.code = code
    this.detail = detail
  }
}

export function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof JotError) return { code: e.code, message: e.message, detail: e.detail }
  const message = e instanceof Error ? e.message : String(e)
  return { code: 'INTERNAL', message }
}
