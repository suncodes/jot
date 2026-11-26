import type { Args, Channel, Ret } from '@shared/ipc'
import { err, ok, toErrorInfo, type Result } from '@shared/result'
import { argSchemas } from './schemas'

export type Handlers = { [K in Channel]: (args: Args<K>) => Promise<Ret<K>> | Ret<K> }

/** 只依赖 ipcMain 的这一个方法，方便在测试里替换 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, args: unknown) => Promise<unknown>): void
}

/** 调用一个处理函数：校验参数、执行、把结果或错误包成 Result */
export async function dispatch<K extends Channel>(handlers: Handlers, channel: K, rawArgs: unknown): Promise<Result<Ret<K>>> {
  const parsed = argSchemas[channel].safeParse(rawArgs)
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.') || '参数'}: ${i.message}`).join('; ')
    return err('INVALID_INPUT', message)
  }
  try {
    return ok(await handlers[channel](parsed.data as Args<K>))
  } catch (e) {
    const info = toErrorInfo(e)
    if (info.code === 'INTERNAL') console.error(`[ipc] ${channel} 出错：`, e)
    return { ok: false, error: info }
  }
}

export function registerIpc(ipcMain: IpcMainLike, handlers: Handlers): void {
  for (const channel of Object.keys(handlers) as Channel[]) {
    ipcMain.handle(channel, (_event, args) => dispatch(handlers, channel, args))
  }
}
