import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
const scope = (path: string, recursive = true) => ({ selection: { kind: 'directory' as const, path, recursive } })

describe('统一内容库路径投影', () => {
  it('原文和摘要合为一项，附件属性取附属文件；原文和摘要均可检索', async () => {
    const source = 'content/工作/评审.txt', summary = 'wiki/sources/评审.md'
    app.write(source, '原文独有词：续航目标六个月。')
    await app.core.vault.patchFrontmatter({ path: source }, { tags: ['硬件/续航'], people: ['周航'], status: '已归类' }, 'user')
    app.write(summary, '---\ntype: source-summary\nsource: content/工作/评审.txt\ntags: [摘要自己的标签]\n---\n摘要独有词：验证方案。')
    await app.core.syncIndex()
    const all = await app.call('library:query', {})
    expect(all.total).toBe(1)
    expect(all.items[0]).toMatchObject({ path: source, title: '评审.txt', kind: 'file', classification: { tags: ['硬件/续航'] } })
    for (const text of ['原文独有词', '摘要独有词', '续航目标 验证方案']) expect((await app.call('library:query', { text, scope: scope('content/工作') })).total).toBe(1)
    expect((await app.call('library:resolve', { path: summary }))?.path).toBe(source)
    const evidence = app.core.index.search({ text: '续航目标', filter: { tags: ['硬件'], people: ['周航'] } }).items[0]!
    expect(evidence.doc.path).toBe(source)
    expect(evidence.chunk.path).toBe(source)
  })

  it('不支持格式和无摘要文件仍可见，可筛处理状态和待整理', async () => {
    app.write('inbox/合同.pdf', Buffer.from([0, 2, 1]))
    app.write('content/工作/进度.txt', '当前文件')
    await app.core.vault.patchFrontmatter({ path: 'inbox/合同.pdf' }, { status: '待整理' }, 'user')
    await app.core.syncIndex()
    expect((await app.call('library:query', {})).total).toBe(2)
    const filtered = await app.call('library:query', { text: '合同', fileState: 'unsupported' })
    expect(filtered.items[0]?.file?.text).toBe(false)
    expect((await app.call('library:query', { pending: true })).total).toBe(1)
  })

  it('原件路径缺失时保留摘要独立条目，已删除文件不靠历史登记产生空条目', async () => {
    app.write('wiki/sources/旧资料.md', '---\ntype: source-summary\nsource: content/工作/旧资料.txt\n---\n保留下来的摘要')
    app.write('content/工作/已删除.txt', '即将删除')
    await app.core.syncIndex()
    fs.unlinkSync(app.file('content/工作/已删除.txt'))
    await app.core.syncIndex()
    expect(await app.call('library:query', {})).toMatchObject({ total: 1, items: [{ path: 'wiki/sources/旧资料.md', sourceMissing: true }] })
  })

  it('直属和递归按真实目录区分，idea/log 合为随手记；自定义 project 只作为普通属性保留', async () => {
    app.write('content/工作/直属.md', '直属正文')
    app.write('content/工作/项目甲/笔记.md', '---\nproject: 自定义值\n---\n子目录笔记')
    app.write('inbox/想法.md', '---\ntype: idea\nrelated: [content/工作/项目甲]\n---\n项目想法')
    app.write('inbox/时段.md', '---\ntype: log\n---\n发生过的事')
    await app.core.syncIndex()
    expect((await app.call('library:query', { scope: scope('content/工作', false) })).items.map(x => x.path)).toEqual(['content/工作/直属.md'])
    expect((await app.call('library:query', { scope: scope('content/工作') })).total).toBe(2)
    expect((await app.call('library:query', { kind: 'record' })).total).toBe(2)
    const doc = await app.core.vault.read({ path: 'content/工作/项目甲/笔记.md' })
    expect(doc.properties!.project).toBe('自定义值')
    expect(doc.classification).not.toHaveProperty('project')
    await expect(app.call('search:query', { filter: { project: '项目甲' } } as never)).rejects.toThrow('INVALID_INPUT')
    await expect(app.call('library:query', { project: '项目甲' } as never)).rejects.toThrow('INVALID_INPUT')
  })

  it('完整数据上筛选、计数和分页，不截断前 200 条；名称搜索转义通配符', async () => {
    for (let i = 0; i < 235; i++) app.write('content/工作/条目' + String(i).padStart(3, '0') + '.md', '正文' + i)
    app.write('content/工作/100%完成.md', '精确百分号')
    await app.core.syncIndex()
    const last = await app.call('library:query', { sort: 'name', limit: 30, offset: 210 })
    expect(last.total).toBe(236); expect(last.items).toHaveLength(26)
    expect((await app.call('library:query', { text: '正文234' })).items[0]?.path).toBe('content/工作/条目234.md')
    expect((await app.call('library:query', { text: '%' })).total).toBe(1)
  })
})
