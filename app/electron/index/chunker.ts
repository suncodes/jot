// 把正文切成片段。片段是检索和出处的最小单位，记录它在文件里的起止行号。
// 见 docs/architecture.md。

export interface RawChunk {
  text: string
  /** 文件行号，从 1 开始，含首尾 */
  lineStart: number
  lineEnd: number
}

const TARGET = 500
const MAX = 1200

/**
 * Markdown 按标题和空行分段；相邻的小段合并到 500 字左右，标题总是开启新片段；
 * 超过 1200 字的单段按行再切。firstLine 是正文第一行在文件里的行号。
 */
export function chunkText(body: string, firstLine = 1): RawChunk[] {
  const lines = body.split('\n')
  // 第一步：按空行切成块；代码块内部不切
  const blocks: RawChunk[] = []
  let start = -1
  let inFence = false
  const close = (endExclusive: number) => {
    if (start < 0) return
    blocks.push({ text: lines.slice(start, endExclusive).join('\n'), lineStart: firstLine + start, lineEnd: firstLine + endExclusive - 1 })
    start = -1
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = /^\s*(```|~~~)/.test(line)
    if (!inFence && line.trim() === '') {
      close(i)
      continue
    }
    if (!inFence && /^#{1,6}\s/.test(line) && start >= 0) close(i)
    if (start < 0) start = i
    if (fence) inFence = !inFence
  }
  close(lines.length)

  // 第二步：过长的块按行切开
  const pieces: RawChunk[] = []
  for (const b of blocks) {
    if (b.text.length <= MAX) {
      pieces.push(b)
      continue
    }
    const blockLines = b.text.split('\n')
    let buf: string[] = []
    let bufStart = 0
    let bufEnd = 0
    let size = 0
    const flush = () => {
      if (buf.length) pieces.push({ text: buf.join('\n'), lineStart: b.lineStart + bufStart, lineEnd: b.lineStart + bufEnd })
      buf = []
      size = 0
    }
    blockLines.forEach((l, i) => {
      // 单行就超长时硬切，几段的行号相同
      const parts = l.length > MAX ? (l.match(new RegExp(`[\\s\\S]{1,${MAX}}`, 'g')) ?? [l]) : [l]
      for (const part of parts) {
        if (size + part.length > MAX && buf.length) flush()
        if (!buf.length) bufStart = i
        buf.push(part)
        bufEnd = i
        size += part.length + 1
      }
    })
    flush()
  }

  // 第三步：合并相邻的小块，标题开启新片段
  const out: RawChunk[] = []
  for (const p of pieces) {
    const last = out.at(-1)
    const isHeading = /^#{1,6}\s/.test(p.text)
    if (last && !isHeading && last.text.length + p.text.length <= TARGET) {
      last.text += '\n\n' + p.text
      last.lineEnd = p.lineEnd
    } else {
      out.push({ ...p })
    }
  }
  return out.filter((c) => c.text.trim() !== '')
}
