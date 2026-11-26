import type { ToolCall, ToolErrorKind } from '@shared/assistant'
import { JotError } from '@shared/result'

/** 区分业务参数校验与已进入执行阶段的失败。 */
export class ToolInputError extends JotError {
  constructor(message: string) { super('INVALID_INPUT', message) }
}
const labels: Record<ToolErrorKind, string> = { json: '参数 JSON 格式错误', validation: '参数校验失败', execution: '执行失败' }

export function toolFailure(name: string, kind: ToolErrorKind, message: string): Pick<ToolCall, 'ok' | 'errorKind' | 'summary' | 'output'> {
  return { ok: false, errorKind: kind, summary: name + ' · ' + labels[kind], output: message }
}

/** SDK 的 JSON／Schema 拒绝发生在工具 execute 之前；保留原始输入，不截取或执行猜测修复后的参数。 */
export function sdkToolFailure(name: string, result: { content: { type: string; text?: string }[] }, input: unknown, argumentsError?: string): Pick<ToolCall, 'ok' | 'errorKind' | 'summary' | 'input' | 'output'> {
  const text = result.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
  const marker = '\n\nReceived arguments:\n'
  const rawIndex = argumentsError?.indexOf(marker) ?? -1
  const detailIndex = text.indexOf(marker)
  const message = detailIndex < 0 ? text : text.slice(0, detailIndex)
  const kind: ToolErrorKind = argumentsError || text.startsWith('Invalid arguments for tool "') ? 'json'
    : text.startsWith('Validation failed for tool "') ? 'validation' : 'execution'
  const hint = kind === 'json'
    ? '\n请重新发送一个完整 JSON 对象，JSON 外不要附带文本或其他对象；本次未执行。'
    : kind === 'validation' ? '\n请按工具参数定义修正后重试；app_manage 的具体参数可用 app_help 查询。本次未执行。' : ''
  return { ...toolFailure(name, kind, message + hint),
    input: rawIndex >= 0 ? argumentsError!.slice(rawIndex + marker.length) : input }
}
