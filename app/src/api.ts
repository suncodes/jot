import type { Args, Channel, EventContract, EventName, Ret } from '@shared/ipc'
import type { ErrorInfo, Result } from '@shared/result'

/** 界面里用来表示一次调用失败 */
export class ApiError extends Error {
  readonly code: ErrorInfo['code']
  readonly detail?: unknown

  constructor(info: ErrorInfo) {
    super(info.message)
    this.name = 'ApiError'
    this.code = info.code
    this.detail = info.detail
  }
}

/** 调用主进程，返回 Result，由调用方处理失败 */
export function invoke<K extends Channel>(channel: K, ...args: Args<K> extends void ? [] : [Args<K>]): Promise<Result<Ret<K>>> {
  return window.jot.invoke(channel, ...args)
}

/** 调用主进程，失败时抛出 ApiError */
export async function call<K extends Channel>(channel: K, ...args: Args<K> extends void ? [] : [Args<K>]): Promise<Ret<K>> {
  const r = await window.jot.invoke(channel, ...args)
  if (!r.ok) throw new ApiError(r.error)
  return r.data
}

export function on<E extends EventName>(event: E, listener: (data: EventContract[E]) => void): () => void {
  return window.jot.on(event, listener)
}
