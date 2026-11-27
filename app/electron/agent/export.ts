import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { answerSourceLinks } from '@shared/answer-note'
import type { ConversationExportFormat, ConversationSnapshot } from '@shared/conversation-export'
import type { ChatMessage } from '@shared/types'
import type { ToolCall } from '@shared/assistant'
import { JotError } from '@shared/result'
import type { VaultService } from '../vault/vault'
import { resolveInVault } from '../vault/paths'
import { writeFileAtomic } from '../util/fs'

const extension = (format: ConversationExportFormat) => format === 'markdown' ? '.md' : '.jsonl'
const line = (value: string) => value.replace(/\s+/g, ' ').trim()
const html = (value: string) => line(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)

export function conversationExportName(title: string, format: ConversationExportFormat): string {
  let name = line(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').slice(0, 80).replace(/[. ]+$/, '') || '对话'
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '对话-' + name
  return name + extension(format)
}
function fence(value: string, language: string): string {
  const tick = String.fromCharCode(96)
  const width = Math.max(3, ...[...value.matchAll(new RegExp(tick + '+', 'g'))].map(match => match[0].length + 1))
  const marker = tick.repeat(width)
  return marker + language + '\n' + value + (value.endsWith('\n') ? '' : '\n') + marker
}
function toolMarkdown(call: ToolCall): string {
  const state = call.ok === true ? '成功' : call.ok === false ? '失败' : '未完成'
  const fields = ['<details>', '<summary>' + html(call.name) + ' · ' + state + '</summary>', '', line(call.summary)]
  if (call.durationMs !== undefined) fields.push('', '耗时：' + call.durationMs + ' ms')
  if (call.input !== undefined) fields.push('', '输入：', '', fence(JSON.stringify(call.input, null, 2), 'json'))
  if (call.output !== undefined) fields.push('', '输出：', '', fence(call.output, 'text'))
  if (call.confirmation) fields.push('', '操作确认：', '', fence(JSON.stringify(call.confirmation, null, 2), 'json'))
  fields.push('', '</details>')
  return fields.join('\n')
}
/** 同盘写普通相对链接，跨盘写文件 URL；引用指向导出时的来源，不复制来源正文。 */
function sourceHref(root: string, target: string, source: string): string | null {
  try {
    const absolute = path.isAbsolute(source) ? path.resolve(source) : resolveInVault(root, source)
    const relative = path.relative(path.dirname(target), absolute).split(path.sep).join('/')
    const encoded = path.isAbsolute(relative) ? pathToFileURL(absolute).href : encodeURI(relative)
    return encoded.replace(/[?#()[\]]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  } catch { return null }
}
function messageMarkdown(message: ChatMessage, index: number, root: string, target: string): string {
  const fields = ['## ' + (index + 1) + '. ' + (message.role === 'user' ? '用户' : '助手'), '', '时间：' + message.createdAt]
  if (message.context) {
    fields.push('智能体：' + line(message.context.agent.name) + (message.context.model ? '；模型：' + line((message.context.modelUse?.channelName ? message.context.modelUse.channelName + ' / ' : '') + (message.context.modelUse?.name || message.context.model)) : ''))
    if (message.context.skillIds.length) fields.push('显式技能：' + message.context.skillIds.map(line).join('、'))
    if (message.context.references.length) fields.push('范围：' + (message.context.strict ? '仅根据材料' : '参考材料') + '；' + message.context.references.map(item => line(item.value)).join('、'))
  }
  if (message.runHidden) fields.push('运行记录：已隐藏，原对话仍保留')
  if (message.runState === 'interrupted') fields.push('状态：回答中断')
  if (message.error) fields.push('未完成原因：' + line(message.error))
  if (message.budget) fields.push('上下文估算：' + message.budget.inputTokens + ' / ' + message.budget.contextWindow + ' Token'
    + (message.budget.summarizedTurns ? '；摘要承接 ' + message.budget.summarizedTurns + ' 轮' : ''))
  fields.push('', message.role === 'assistant' ? answerSourceLinks(message.text, message.citations ?? [], source => sourceHref(root, target, source)) : message.text)
  // 正文完整导出，工具细节单列便于阅读；JSONL 另保留 parts 的实际交错顺序。
  const parts = message.parts?.filter(part => part.type === 'tool')
  const tools = parts?.length ? parts.map(part => part.call) : message.toolCalls ?? []
  if (tools.length) fields.push('', '### 工具过程', '', ...tools.map(toolMarkdown))
  return fields.join('\n')
}
export function renderConversation(snapshot: ConversationSnapshot, format: ConversationExportFormat, root: string, target: string): string {
  if (format === 'jsonl') {
    return [
      { type: 'conversation', format: 'jot-conversation', version: 1, exportedAt: snapshot.exportedAt, conversation: snapshot.info, context: snapshot.context },
      ...snapshot.messages.map(message => ({ type: 'message', message })),
      ...snapshot.summaries.map(summary => ({ type: 'summary', ...summary })),
    ].map(record => JSON.stringify(record)).join('\n') + '\n'
  }
  const fields = ['# ' + line(snapshot.info.title), '', '对话编号：' + snapshot.info.conversationId,
    '创建时间：' + snapshot.info.createdAt, '更新时间：' + snapshot.info.updatedAt, '导出时间：' + snapshot.exportedAt, '',
    '完整问答与工具过程如下。来源链接指向导出时的实际文件，文件移动后可能需要调整链接。', '',
    ...snapshot.messages.map((message, index) => messageMarkdown(message, index, root, target))]
  if (!snapshot.messages.length) fields.push('尚无消息。')
  if (snapshot.summaries.length) {
    fields.push('', '<details>', '<summary>对话接续摘要</summary>', '', '以下摘要供后续问答接续，完整历史保留在上方。')
    for (const summary of snapshot.summaries) fields.push('', '### ' + (summary.mode === 'strict' ? '严格材料模式' : '普通模式'), '',
      '覆盖到消息：' + summary.throughMessageId, '更新时间：' + summary.updatedAt, '', fence(summary.summary, 'text'))
    fields.push('', '</details>')
  }
  return fields.join('\n') + '\n'
}
/** 目标只来自系统保存窗口；库内写入仍经过库服务的权限检查。 */
export async function saveConversationExport(vault: VaultService, snapshot: ConversationSnapshot, format: ConversationExportFormat, target: string): Promise<void> {
  if (!path.isAbsolute(target) || path.extname(target).toLowerCase() !== extension(format)) {
    throw new JotError('INVALID_INPUT', '请选择 ' + extension(format) + ' 格式的完整保存路径')
  }
  const body = renderConversation(snapshot, format, vault.path, target)
  const relative = path.relative(vault.path, target)
  try {
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      await vault.writeExport(relative.split(path.sep).join('/'), body)
    } else {
      const stat = await fs.promises.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (stat?.isSymbolicLink() || stat && !stat.isFile()) throw new JotError('INVALID_INPUT', '请选择普通文件作为导出目标')
      await writeFileAtomic(target, body)
    }
  } catch (error) {
    if (error instanceof JotError) throw error
    throw new JotError('IO_ERROR', '导出失败：' + (error instanceof Error ? error.message : String(error)))
  }
}
