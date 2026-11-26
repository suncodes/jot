import { describe, expect, it } from 'vitest'
import { previewDateNote, validateResourcePath } from '@shared/date-paths'

const filename = '{{yyyy}}-{{MM}}-{{dd}} 工作日记.md'

describe('日期笔记路径', () => {
  it.each([
    ['content/工作/工作日记/{{yyyy}}年/{{MM}}月', 'content/工作/工作日记/2026年/11月'],
    ['content/工作/工作日记/{{yyyy}}年-{{MM}}月', 'content/工作/工作日记/2026年-11月'],
    ['content/工作/{{yyyy}}/工作日记/{{MM}}/记录', 'content/工作/2026/工作日记/11/记录'],
    ['content/生活/日记', 'content/生活/日记'],
  ])('自由目录 %s 与文件名使用同一本地日期', (directory, expected) => {
    expect(previewDateNote({ directory, filename }, new Date(2026, 10, 23, 23, 59))).toEqual({
      directory: expected, filename: '2026-11-23 工作日记.md', path: expected + '/2026-11-23 工作日记.md', date: '2026-11-23',
    })
  })

  it('日期可以全部放在目录中，文件名补 Markdown 后缀', () => {
    expect(previewDateNote({ directory: 'content/日记/{{yyyy}}/{{MM}}/{{dd}}', filename: '今日记录' }, new Date(2027, 0, 1)))
      .toEqual({ directory: 'content/日记/2027/01/01', filename: '今日记录.md', path: 'content/日记/2027/01/01/今日记录.md', date: '2027-01-01' })
  })

  it('跨月跨年与闰日按传入的本地日期变化，不把 UTC 当本地日期', () => {
    const rule = { directory: 'content/日记/{{yyyy}}-{{MM}}', filename: '{{dd}}.markdown' }
    for (const now of [new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1), new Date(2028, 1, 29)]) {
      const local = [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')]
      expect(previewDateNote(rule, now).path).toBe(`content/日记/${local[0]}-${local[1]}/${local[2]}.markdown`)
    }
  })

  it.each([
    '/content/日记', 'C:/日记', '../content/日记', 'content/../日记', 'content//日记', 'content/日记/',
    'content/CON', 'content/LPT1.md', 'content/坏:名', 'content/坏?名', 'content/尾点.', 'content/尾空格 ',
    'content/.隐藏', 'content/日记\\子目录', 'inbox/日记', 'ideas/日记', '.jot/日记', 'templates/日记',
    'content/日记/{{YY}}', 'content/日记/{yyyy}', 'content/日记/{{yyyy',
  ])('拒绝非法目录 %s，不静默规范化或回退', directory => {
    expect(() => previewDateNote({ directory, filename }, new Date(2026, 10, 23))).toThrow()
  })

  it.each(['../{{yyyy}}-{{MM}}-{{dd}}.md', '子目录/{{yyyy}}-{{MM}}-{{dd}}.md', 'CON.md', '{{yyyy}}-{{MM}}-{{dd}}.md ', '{{yyyy}}-{{MM}}-{{dd}} {{title}}.md'])('拒绝非法文件名 %s', invalid => {
    expect(() => previewDateNote({ directory: 'content/日记', filename: invalid }, new Date())).toThrow()
  })

  it('整个路径需要年、月、日，裸 yyyy 不作为兼容语法', () => {
    expect(() => previewDateNote({ directory: 'content/yyyy/MM', filename: '{{dd}}.md' }, new Date())).toThrow('年、月、日')
    expect(() => previewDateNote({ directory: 'content/日记', filename }, new Date('invalid'))).toThrow('日期无效')
    expect(() => previewDateNote({ directory: 'content/' + '长'.repeat(256), filename }, new Date())).toThrow('非法名称')
  })

  it('模板引用限制为独立 templates 根下 Markdown 资源', () => {
    expect(() => validateResourcePath('templates/工作/日记.md')).not.toThrow()
    for (const value of ['content/模板/日记.md', 'templates/../secret.md', 'templates/脚本.js', '/templates/日记.md', '.jot/模板.md']) {
      expect(() => validateResourcePath(value)).toThrow()
    }
  })
})
