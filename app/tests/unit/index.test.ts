import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandTokens, IndexService, makeSnippet, type IndexInput } from '../../electron/index/index'
import { makeTmpDir } from '../helpers/tmp'

let tmp: ReturnType<typeof makeTmpDir>
let index: IndexService
let clock = 0

const input = (rel: string, text: string, created = '2026-11-13T10:00:00+08:00'): IndexInput => ({
  path: rel, text, mtimeMs: ++clock, size: text.length, birthtime: new Date(created), mtime: new Date(created),
})
const idea = (n: number, body: string, extra = '', day = '2026-11-13') =>
  input(`inbox/${day} 1000${String(n).padStart(2, '0')}.md`, `---\nid: ID${n}\ntype: idea\ncreated: ${day}T10:00:${String(n).padStart(2, '0')}+08:00\n${extra}---\n${body}\n`)

beforeEach(() => {
  tmp = makeTmpDir('index')
  index = new IndexService()
  index.open(path.join(tmp.dir, '.jot/index.db'))
})
afterEach(() => {
  index.close()
  tmp.cleanup()
})

describe('索引：写入与读取', () => {
  it('写入后能按路径找到，原 id 仅作为普通属性保留，带上归类属性', () => {
    const meta = index.upsert(idea(1, '过年要买零食和年货', 'domain: 生活\ntags: [过年, 零食]\npeople: [爸妈]\nstatus: 已归类\nclassified_by: ai\n'))
    expect(meta.title).toBe('过年要买零食和年货')
    expect(index.getDoc(meta.path)?.properties?.id).toBe('ID1')
    expect(index.getDoc(meta.path)).toMatchObject({
      path: 'inbox/2026-11-13 100001.md', type: 'idea',
      classification: { tags: ['过年', '零食'], people: ['爸妈'] },
    })
    expect(index.count()).toBe(1)
  })

  it('片段带文件行号，编号是 6 位十六进制，内容不变时编号不变', () => {
    const doc = idea(1, '第一段\n\n# 标题\n第二段')
    index.upsert(doc)
    const chunks = index.chunksOf(doc.path)
    expect(chunks.map((c) => [c.lineStart, c.lineEnd, c.text])).toEqual([[6, 6, '第一段'], [8, 9, '# 标题\n第二段']])
    for (const c of chunks) expect(c.chunkId).toMatch(/^[0-9a-f]{6}$/)
    expect(index.getChunk(chunks[1]!.chunkId)).toMatchObject({ path: doc.path, lineStart: 8 })
    expect(index.chunksOf(doc.path, [8, 8]).map((c) => c.lineStart)).toEqual([8])

    const before = chunks.map((c) => c.chunkId)
    index.upsert({ ...doc, mtimeMs: ++clock })
    expect(index.chunksOf(doc.path).map((c) => c.chunkId)).toEqual(before)
  })

  it('内容改了以后旧片段不再能搜到', () => {
    const a = idea(1, '关于需求评审的想法')
    index.upsert(a)
    index.upsert({ ...idea(1, '改成了接口设计的想法'), path: a.path })
    expect(index.search({ text: '需求评审' }).total).toBe(0)
    expect(index.search({ text: '接口设计' }).total).toBe(1)
  })

  it('删除后搜不到，也查不到', () => {
    const a = idea(1, '将要删除的内容')
    index.upsert(a)
    index.remove(a.path)
    expect(index.getDoc(a.path)).toBeNull()
    expect(index.search({ text: '将要删除' }).total).toBe(0)
    expect(index.allPaths()).toEqual([])
  })

  it('修改时间和大小没变时不需要重新索引', () => {
    const a = idea(1, '内容')
    expect(index.needsUpdate(a.path, a.mtimeMs, a.size)).toBe(true)
    index.upsert(a)
    expect(index.needsUpdate(a.path, a.mtimeMs, a.size)).toBe(false)
    expect(index.needsUpdate(a.path, a.mtimeMs + 1, a.size)).toBe(true)
  })

  it('索引文件损坏时自动重建', () => {
    index.close()
    const file = path.join(tmp.dir, 'bad/index.db')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '这不是数据库')
    index.open(file)
    expect(index.count()).toBe(0)
  })
})

describe('搜索', () => {
  beforeEach(() => {
    index.upsert(idea(1, '过年回老家前要买零食和年货', 'domain: 生活\ntags: [过年, 生活/零食]\nstatus: 已归类\n'))
    index.upsert(idea(2, '下周三的需求评审要先把接口文档发出去', 'domain: 工作\ntags: [人生笔记]\nstatus: 已归类\n'))
    index.upsert(idea(3, '给爸妈买点坚果，过年带回去', 'people: [爸妈]\nstatus: 待整理\n', '2026-11-10'))
    index.upsert(input('content/需求评审纪要.md', '# 结论\n接口先不改\n\n# 待办\n补充文档', '2026-11-12T09:00:00+08:00'))
  })

  it('三个字以上的词走全文索引', () => {
    const r = index.search({ text: '需求评审' })
    expect(r.total).toBe(2)
    expect(r.items.map((h) => h.doc.path).sort()).toEqual(['content/需求评审纪要.md', 'inbox/2026-11-13 100002.md'])
  })

  it('两个字的词也能搜到（退回子串匹配）', () => {
    const r = index.search({ text: '过年' })
    expect(r.items.map((h) => h.doc.path).sort()).toEqual(['inbox/2026-11-10 100003.md', 'inbox/2026-11-13 100001.md'])
    expect(index.search({ text: '买' }).total).toBe(2)
  })

  it('多个词之间是并且', () => {
    expect(index.search({ text: '过年 坚果' }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-10 100003.md'])
    expect(index.search({ text: '需求评审 接口文档' }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-13 100002.md'])
    expect(index.search({ text: '过年 需求评审' }).total).toBe(0)
  })

  it('按文件名也能搜到；每个文件只返回一个片段', () => {
    const r = index.search({ text: '评审纪要' })
    expect(r.items.map((h) => h.doc.path)).toEqual(['content/需求评审纪要.md'])
    const multi = index.search({ text: '文档' })
    expect(multi.items.filter((h) => h.doc.path === 'content/需求评审纪要.md')).toHaveLength(1)
  })

  it('命中片段带高亮区间和行号', () => {
    const hit = index.search({ text: '需求评审' }).items.find((h) => h.doc.path === 'inbox/2026-11-13 100002.md')!
    expect(hit.snippet).toContain('需求评审')
    const [from, to] = hit.highlights[0]!
    expect(hit.snippet.slice(from, to)).toBe('需求评审')
    expect(hit.chunk.lineStart).toBe(9)
    expect(hit.chunk.chunkId).toMatch(/^[0-9a-f]{6}$/)
  })

  it('特殊字符不会破坏查询', () => {
    for (const q of ['"引号"', "it's", '100%', 'a_b', '(括号)', 'AND OR NOT', '*']) {
      expect(() => index.search({ text: q })).not.toThrow()
    }
    index.upsert(idea(9, '折扣是 100% 吗'))
    expect(index.search({ text: '0%' }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-13 100009.md'])
  })

  it('按领域、路径材料、标签、人物、类型、时间、状态筛选', () => {
    expect(index.search({ filter: { tags: ['过年'] } }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-13 100001.md'])
    expect(index.search({ filter: { materials: [{ kind: 'file', value: 'inbox/2026-11-13 100002.md' }] } }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-13 100002.md'])
    expect(index.search({ filter: { tags: ['过年'] } }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-13 100001.md'])
    // 分层标签：筛上一层时包含下一层
    expect(index.search({ filter: { tags: ['生活'] } }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-13 100001.md'])
    expect(index.search({ filter: { people: ['爸妈'] } }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-10 100003.md'])
    expect(index.search({ filter: { types: ['note'] } }).items.map((h) => h.doc.path)).toEqual(['content/需求评审纪要.md'])
    expect(index.search({ filter: { from: '2026-11-11', to: '2026-11-12' } }).items.map((h) => h.doc.path)).toEqual(['content/需求评审纪要.md'])
    expect(index.search({ filter: { scope: { selection: { kind: 'collection', name: 'pending' } } } }).items.every(h => h.doc.path.startsWith('inbox/'))).toBe(true)
  })

  it('筛选条件可以和关键词组合；不输关键词时按时间倒序', () => {
    expect(index.search({ text: '过年', filter: { tags: ['过年'] } }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-13 100001.md'])
    expect(index.search({}).items.map((h) => h.doc.path)).toEqual([
      'inbox/2026-11-13 100002.md', 'inbox/2026-11-13 100001.md', 'content/需求评审纪要.md', 'inbox/2026-11-10 100003.md',
    ])
  })

  it('按标签、人物也能搜到带这些归类的记录', () => {
    // 这几条的正文里都没有这些词，是文件头里的归类
    expect(index.search({ text: '人生笔记' }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-13 100002.md'])
    expect(index.search({ text: '爸妈' }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-10 100003.md'])
    expect(index.search({ text: '人生笔记 接口文档' }).items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-13 100002.md'])
  })

  it('放宽查找：出现任意一个词就算，出现得多的在前；长词拆成两字组合', () => {
    // 严格查找：这几个词没有同时出现在任何一条里
    expect(index.search({ text: '过年 打算 采购' }).total).toBe(0)
    const loose = index.search({ text: '过年 坚果 采购', mode: 'any' })
    expect(loose.items.map((h) => h.doc.path)).toEqual(['inbox/2026-11-10 100003.md', 'inbox/2026-11-13 100001.md'])
    // “人生笔记资料” 原文里没有，拆开后 人生、笔记 能对上
    expect(index.search({ text: '人生笔记资料' }).total).toBe(0)
    expect(index.search({ text: '人生笔记资料', mode: 'any' }).items[0]!.doc.path).toBe('inbox/2026-11-13 100002.md')
    expect(index.search({ text: '完全无关的词语', mode: 'any', filter: { tags: ['过年'] } }).total).toBe(0)
    // 只碰巧对上一个两字组合的不算（这里只有“回去”能对上）
    expect(index.search({ text: '回去休息', mode: 'any' }).total).toBe(0)
    // 含“的、了、是”这类字的组合不拿来匹配
    expect(expandTokens(['不存在的词'])).toEqual(['不存在的词'])
    expect(expandTokens(['智能门锁二期', '功能', 'abcdef'])).toEqual(['智能门锁二期', '功能', 'abcdef', '智能', '能门', '门锁', '锁二', '二期'])
  })

  it('分页', () => {
    const all = index.search({ text: '过年', sort: 'time' })
    const first = index.search({ text: '过年', sort: 'time', limit: 1 })
    const second = index.search({ text: '过年', sort: 'time', limit: 1, offset: 1 })
    expect(first.total).toBe(2)
    expect([first.items[0]!.doc.path, second.items[0]!.doc.path]).toEqual(all.items.map((h) => h.doc.path))
  })

  it('按名称快速打开：完全相同的排最前', () => {
    index.upsert(input('content/评审.md', 'x'))
    const titles = index.quickOpen('评审').map((d) => d.title)
    expect(titles[0]).toBe('评审')
    expect(titles).toContain('需求评审纪要')
    expect(index.quickOpen('').length).toBe(5)
    expect(index.quickOpen('不存在的名字')).toEqual([])
  })
})

describe('摘要片段', () => {
  it('以关键词为中心截取，前后加省略号', () => {
    const text = '开头'.repeat(60) + '关键词' + '结尾'.repeat(60)
    const { snippet, highlights } = makeSnippet(text, ['关键词'], 40)
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.slice(...highlights[0]!)).toBe('关键词')
  })
  it('没有关键词时取开头；不区分大小写', () => {
    expect(makeSnippet('一段内容', [])).toEqual({ snippet: '一段内容', highlights: [] })
    expect(makeSnippet('Hello World', ['world']).highlights).toEqual([[6, 11]])
  })
})
