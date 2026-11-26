import { JotError } from './result'

export function expandNoteTemplate(template: string, input: { date: string; title: string }): string {
  const values: Record<string, string> = { yyyy: input.date.slice(0, 4), MM: input.date.slice(5, 7), dd: input.date.slice(8, 10), date: input.date, title: input.title }
  const expanded = template.replace(/\{\{([^{}]*)\}\}/g, (_, token: string) => {
    if (!Object.hasOwn(values, token)) throw new JotError('INVALID_INPUT', '未知模板变量：{{' + token + '}}')
    return values[token]!
  })
  if (expanded.includes('{{')) throw new JotError('INVALID_INPUT', '模板变量缺少结束标记 }}')
  return expanded
}
