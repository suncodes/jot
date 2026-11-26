import { z } from 'zod'
import type { SearchFilter } from '@shared/types'
import { JotError } from '@shared/result'
import type { AppOperations } from '../operations/service'
import type { AgentFiles, ConfirmFiles } from './files'
export interface OperationContext {
  app: AppOperations
  files: AgentFiles
  scope: SearchFilter
  conversationId: string
  confirm: ConfirmFiles
  signal?: AbortSignal
}
export interface Operation {
  name: string
  description: string
  schema: z.ZodType
  example: object
  write: boolean
  run: (input: never, context: OperationContext) => unknown | Promise<unknown>
}
export const operation = <T>(name: string, description: string, schema: z.ZodType<T>, example: z.input<typeof schema>, write: boolean,
  run: (input: T, context: OperationContext) => unknown | Promise<unknown>): Operation => ({
  name, description, schema, example: example as object, write, run: run as Operation['run'],
})
const check = (context: OperationContext) => {
  if (context.signal?.aborted) throw new JotError('CANCELLED', '操作已停止')
}
export const noGlobalScope = (context: OperationContext) => {
  if (context.scope.materials || context.scope.scope) throw new JotError('WRITE_DENIED', '此操作会访问限定材料外的数据；请取消“仅根据材料”后明确执行')
}
export async function approve(context: OperationContext, title: string, targets: Parameters<ConfirmFiles>[1]) {
  if (!await context.confirm(title, targets)) throw new JotError('CANCELLED', '用户取消了操作')
  check(context)
}
