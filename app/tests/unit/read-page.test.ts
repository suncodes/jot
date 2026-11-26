import { describe, expect, it } from 'vitest'
import { readPage, type ReadPosition } from '../../electron/agent/read-page'

const doc = (body: string, bodyStartLine = 1) => ({ body, bodyStartLine })

describe('当前文件分段读取', () => {
  it('精确裁剪行闭区间，使用含frontmatter的实际行号并保留CRLF', () => {
    expect(readPage(doc('甲\r\n乙\r\n丙', 5), { lineStart: 6, lineEnd: 6 })).toEqual({
      text: '乙\r\n', lineStart: 6, lineEnd: 6, columnStart: 1, next: null,
    })
    expect(readPage(doc('甲\n乙', 5), { lineStart: 1, lineEnd: 4 }).text).toBe('')
    expect(readPage(doc('甲\n乙', 5), { lineStart: 1, lineEnd: 5 }).text).toBe('甲\n')
  })

  it('超长单行逐列续读，所有字符恰好读取一次', () => {
    const input = doc('开头' + '长'.repeat(14050) + '结尾', 7)
    let next: ReadPosition | null = { lineStart: 1, columnStart: 1 }
    const pages: string[] = [], positions: ReadPosition[] = []
    while (next) {
      positions.push(next)
      const page = readPage(input, next)
      pages.push(page.text); next = page.next
      expect(pages.length).toBeLessThan(5)
    }
    expect(pages.join('')).toBe(input.body)
    expect(positions).toEqual([{ lineStart: 1, columnStart: 1 }, { lineStart: 7, columnStart: 6001 }, { lineStart: 7, columnStart: 12001 }])
  })

  it('跨行与空行连续分页不重叠不遗漏，最后next为空', () => {
    const input = doc(Array.from({ length: 80 }, (_unused, index) => index % 3 ? '第' + index + '行\r\n' : '较长'.repeat(240) + '\r\n').join(''), 9)
    let next: ReadPosition | null = { lineStart: 9, columnStart: 1 }
    let actual = '', count = 0
    while (next) {
      const page = readPage(input, next)
      expect(page.text.length).toBeLessThanOrEqual(6000)
      actual += page.text; next = page.next; count++
      expect(count).toBeLessThan(10)
    }
    expect(count).toBeGreaterThan(1)
    expect(actual).toBe(input.body)
  })

  it('限定结束行的长行续读不读取后续正文', () => {
    const input = doc('之前\n' + 'a'.repeat(6100) + '\n不该读到')
    const first = readPage(input, { lineStart: 2, lineEnd: 2 })
    expect(first.next).toEqual({ lineStart: 2, columnStart: 6001 })
    const second = readPage(input, { ...first.next!, lineEnd: 2 })
    expect(first.text + second.text).toBe('a'.repeat(6100) + '\n')
    expect(second.next).toBeNull()
    expect(readPage(input, { lineStart: 1, columnStart: 3, lineEnd: 1 }).text).toBe('\n')
  })

  it('分页不会拆开emoji代理对，后续列位置仍可复用', () => {
    const input = doc('a'.repeat(5999) + '😀' + '尾部')
    const first = readPage(input)
    expect(first.text).toBe('a'.repeat(5999))
    expect(readPage(input, first.next!).text).toBe('😀尾部')
  })

  it.each([{ lineStart: 0 }, { lineStart: 1.2 }, { lineStart: -1 }, { lineStart: 3, lineEnd: 2 }, { columnStart: 0 }, { columnStart: 99 }])('非法行列返回实际错误：%j', range => {
    expect(() => readPage(doc('甲\n乙'), range)).toThrow('读取')
  })

  it('空文件和正文外范围没有伪造片段或续读位置', () => {
    expect(readPage(doc(''))).toMatchObject({ text: '', next: null })
    expect(readPage(doc('正文', 6), { lineStart: 9 })).toMatchObject({ text: '', next: null })
  })
})
