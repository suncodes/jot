import { CITATION_SOURCE } from './citations'
import { absoluteFileHref, isAbsoluteFilePath } from './file-links'
import type { Citation } from './types'

/** 将回答出处写成普通 Markdown 链接：库内相对保存目录，库外使用文件 URL，不依赖会话或片段索引。 */
export function answerNoteBody(text: string, citations: Citation[], directory: string): string {
  const relative = (target: string): string => {
    const from = directory.split('/').filter(Boolean), to = target.split('/')
    while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift() }
    return [...from.map(() => '..'), ...to].join('/')
  }
  return answerSourceLinks(text, citations, target => isAbsoluteFilePath(target) ? absoluteFileHref(target) : encodeURI(relative(target)).replace(/[?#()[\]]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()))
}

/** 共用正文出处转换，调用者决定保存位置；代码示例保持原样。 */
export function answerSourceLinks(text: string, citations: Citation[], href: (path: string) => string | null): string {
  const replace = (value: string): string => value.replace(new RegExp(CITATION_SOURCE, 'g'), (_, marker: string) => {
    const cite = citations.find(item => item.marker === marker && item.valid && item.chunk)
    if (!cite?.chunk) return '（来源未核实）'
    const chunk = cite.chunk
    const label = chunk.path.split('/').pop()!.replace(/\.(md|markdown)$/i, '') + ':' + chunk.lineStart
    const escaped = label.replace(/[\\[\]]/g, '\\$&')
    const target = href(chunk.path)
    return target ? '[' + escaped + '](' + target + ')' : '（来源未核实）'
  })
  // 代码示例中的出处语法原样保留。
  let fence: { marker: string; width: number } | undefined
  return text.split(/(?<=\n)/).map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.width && !line.slice(match[0].length).trim()) fence = undefined
      return line
    }
    if (match) { fence = { marker: match[1]![0]!, width: match[1]!.length }; return line }
    if (/^(?: {4}|\t)/.test(line)) return line
    return line.split(/(`+[^\n]*?`+(?!`))/g).map((part, index) => index % 2 ? part : replace(part)).join('')
  }).join('')
}
