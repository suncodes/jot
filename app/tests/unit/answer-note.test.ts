import { absoluteFileHref } from '../../shared/file-links'
import { describe, expect, it } from 'vitest'
import type { Citation } from '../../shared/types'
import { answerNoteBody } from '../../shared/answer-note'
import { resolveTarget, scanLinks } from '../../electron/vault/links'

const citation = (marker: string, path: string, lineStart = 3): Citation => ({
  marker, valid: true, chunk: { path, lineStart } as Citation['chunk'],
})

describe('回答保存为普通 Markdown', () => {
  it('跨目录出处转换为真实相对链接，切换存放位置后重新计算，不依赖片段编号', () => {
    const paths = ['content/工作/项目甲/进展.md', 'content/工作/项目乙/进展.md']
    const citations = paths.map((path, index) => citation('cite' + index, path))
    const text = '项目甲完成[^cite0]，项目乙进行中[^cite1]，再次引用[^cite0]。'
    for (const dir of ['content/工作/周报', 'content/生活/回顾']) {
      const body = answerNoteBody(text, citations, dir)
      const links = scanLinks(body)
      expect(links).toHaveLength(3)
      expect(links.map(link => resolveTarget(dir + '/周报.md', link.target, link.kind, paths).path)).toEqual([paths[0], paths[1], paths[0]])
      expect(body).not.toContain('[^')
      expect(body).toContain('[进展:3]')
    }
    expect(citations[0]!.marker).toBe('cite0')
    expect(text).toContain('[^cite0]')
  })

  it('文件名含空格、括号、方括号、百分号和井号时链接仍可解析', () => {
    const target = 'content/工作/项目 A/[进展](终稿) 50% #1.md'
    const body = answerNoteBody('内容[^file]', [citation('file', target)], 'content/工作/周报')
    const [link] = scanLinks(body)
    expect(link).toBeDefined()
    expect(resolveTarget('content/工作/周报/汇总.md', link!.target, 'markdown', [target]).path).toBe(target)
    expect(body).toContain('\\[进展\\]')
  })

  it('无效、缺失和未经核实的出处明确标注，不造文件链接', () => {
    const bad = { ...citation('invalid', 'content/坏.md'), valid: false }
    const body = answerNoteBody('甲[^invalid] 乙[^missing] 丙[^empty]', [bad, { marker: 'empty', valid: true }], 'content/工作')
    expect(body).toBe('甲（来源未核实） 乙（来源未核实） 丙（来源未核实）')
    expect(scanLinks(body)).toHaveLength(0)
  })

  it('代码示例保留原文，普通正文继续转换', () => {
    const citations = [citation('a', 'content/工作/材料.md')]
    const text = ['正文[^a]', '`示例[^a]`', '~~~md', '代码[^a]', '~~~', '    缩进[^a]', '再引用[^a]'].join('\n')
    const body = answerNoteBody(text, citations, 'content/工作')
    expect(body).toContain('`示例[^a]`')
    expect(body).toContain('~~~md\n代码[^a]\n~~~')
    expect(body).toContain('    缩进[^a]')
    expect(scanLinks(body)).toHaveLength(2)
  })
})

describe('磁盘来源链接', () => {
  it.each(['D:/材料/项目 [A]/原稿(1) #50%.md', '/home/材料/原稿(1) #50%.md', '//server/share/材料 (1).md'])('库外出处生成标准文件URL：%s', target => {
    const body = answerNoteBody('事实[^ext]', [citation('ext', target)], 'content/工作')
    expect(body).toContain(absoluteFileHref(target))
    expect(body).not.toContain('[^')
    expect(decodeURIComponent(new URL(absoluteFileHref(target)).pathname)).toBe(/^[a-z]:/i.test(target) ? '/' + target : target.startsWith('//') ? target.slice(target.indexOf('/', 2)) : target)
  })
})
