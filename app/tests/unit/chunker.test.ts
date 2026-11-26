import { describe, expect, it } from 'vitest'
import { chunkText } from '../../electron/index/chunker'

describe('切分片段', () => {
  it('短内容是一个片段，行号从正文起始行算', () => {
    expect(chunkText('第一行\n第二行\n', 6)).toEqual([{ text: '第一行\n第二行', lineStart: 6, lineEnd: 7 }])
  })

  it('标题开启新片段，相邻小段合并', () => {
    const chunks = chunkText('前言\n\n# 第一节\n内容一\n\n内容二\n\n## 第二节\n内容三')
    expect(chunks.map((c) => [c.lineStart, c.lineEnd])).toEqual([[1, 1], [3, 6], [8, 9]])
    expect(chunks[1]!.text).toBe('# 第一节\n内容一\n\n内容二')
  })

  it('空内容没有片段', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('\n\n  \n')).toEqual([])
  })

  it('代码块内部的空行不切开', () => {
    const chunks = chunkText('说明\n\n```js\nconst a = 1\n\nconst b = 2\n```\n')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toContain('const a = 1\n\nconst b = 2')
  })

  it('很长的内容切成多个片段，行号连续不重叠，内容不丢', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行：` + '内容'.repeat(20))
    const chunks = chunkText(lines.join('\n'))
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1200)
    expect(chunks[0]!.lineStart).toBe(1)
    expect(chunks.at(-1)!.lineEnd).toBe(200)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.lineStart).toBe(chunks[i - 1]!.lineEnd + 1)
    expect(chunks.map((c) => c.text).join('\n')).toBe(lines.join('\n'))
  })

  it('单行超长时硬切', () => {
    const chunks = chunkText('字'.repeat(3000))
    expect(chunks).toHaveLength(3)
    expect(chunks.every((c) => c.lineStart === 1 && c.lineEnd === 1)).toBe(true)
  })
})
