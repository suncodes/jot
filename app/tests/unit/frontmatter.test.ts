import { describe, expect, it } from 'vitest'
import { buildMeta, typeFromPath } from '../../electron/vault/doc'
import { parseDoc, stringifyDoc } from '../../electron/vault/frontmatter'

const stat = { birthtime: new Date('2026-11-13T10:00:00'), mtime: new Date('2026-11-13T11:00:00') }

describe('文件头', () => {
  it('解析属性和正文，记下正文的起始行', () => {
    const p = parseDoc('---\nid: A1\ntags: [过年, 零食]\ncreated: 2026-11-13T21:40:05+08:00\n---\n正文第一行\n第二行\n')
    expect(p.data).toEqual({ id: 'A1', tags: ['过年', '零食'], created: '2026-11-13T21:40:05+08:00' })
    expect(p.body).toBe('正文第一行\n第二行\n')
    expect(p.bodyStartLine).toBe(6)
    expect(p.hasFrontmatter).toBe(true)
  })

  it('没有文件头、空文件头、带 BOM、CRLF 都能处理', () => {
    expect(parseDoc('只有正文')).toMatchObject({ data: {}, body: '只有正文', bodyStartLine: 1, hasFrontmatter: false })
    expect(parseDoc('---\n---\n正文')).toMatchObject({ data: {}, body: '正文', bodyStartLine: 3 })
    expect(parseDoc('﻿---\r\nid: X\r\n---\r\n正文').data).toEqual({ id: 'X' })
    expect(parseDoc('正文里有 --- 分隔线\n---\n不是文件头').hasFrontmatter).toBe(false)
  })

  it('文件头不是合法 YAML 时标记为无效，正文照常取出', () => {
    const p = parseDoc('---\ntags: [未闭合\n---\n正文')
    expect(p).toMatchObject({ invalid: true, data: {}, body: '正文' })
  })

  it('属性写出后保留数组、未知空值和旧 ID 的值', () => {
    const data = { status: '待整理', tags: ['过年', '零食'], custom: null, id: 'A1', empty: '', people: [], type: 'idea' }
    expect(parseDoc(stringifyDoc(data, '正文\n'))).toMatchObject({ data, body: '正文\n' })
  })

  it('没有属性时只写正文', () => {
    expect(stringifyDoc({}, '正文')).toBe('正文')
  })
})

describe('元数据', () => {
  it('按目录推断类型', () => {
    expect(typeFromPath('inbox/a.md')).toBe('note')
    expect(typeFromPath('ideas/a.md')).toBe('idea')
    expect(typeFromPath('content/x/a.md')).toBe('note')
    expect(typeFromPath('journal/2026/2026-11-13.md')).toBe('daily')
    expect(typeFromPath('wiki/sources/a.md')).toBe('source-summary')
    expect(typeFromPath('content/工作/客户A/a.md')).toBe('note')
    expect(typeFromPath('content/工作/附件/a.md')).toBe('note')
  })

  it('想法取正文第一行作标题；外部缺少状态时不自动成为待整理任务', () => {
    const idea = buildMeta('inbox/2026-11-13 214005.md', parseDoc('---\nid: A\ntype: idea\n---\n\n# 过年要买零食\n还有年货'), stat)
    expect(idea).toMatchObject({ path: 'inbox/2026-11-13 214005.md', type: 'idea', role: 'record', title: '过年要买零食', properties: { id: 'A' } })
    expect(idea).not.toHaveProperty('id')
    expect(idea.classification).not.toHaveProperty('status')
    const note = buildMeta('content/读书笔记.md', parseDoc('内容'), stat)
    expect(note).toMatchObject({ type: 'note', role: 'note', title: '读书笔记' })
    expect(note.classification).not.toHaveProperty('status')
  })

  it('读出归类属性，容忍写法不规范', () => {
    const m = buildMeta('inbox/a.md', parseDoc('---\ndomain: 生活\ntags: 单个标签\npeople: [小王, 小王, ""]\nstatus: 已归类\nclassified_by: ai\ngenerated_by: ai\n---\nx'), stat)
    expect(m.classification).toMatchObject({ tags: ['单个标签'], people: ['小王'] })
    expect(m.generatedByAi).toBe(true)
  })

  it('摘要页记下对应的原件', () => {
    const m = buildMeta('wiki/sources/需求说明.md', parseDoc('---\ntype: source-summary\nsource: "[[content/工作/需求说明.txt]]"\n---\nx'), stat)
    expect(m.sourcePath).toBe('content/工作/需求说明.txt')
  })
})
