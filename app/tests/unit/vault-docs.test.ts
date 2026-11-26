import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VaultChange } from '@shared/types'
import { hashText, VaultService } from '../../electron/vault/vault'
import { parseDoc } from '../../electron/vault/frontmatter'
import { makeTmpDir } from '../helpers/tmp'

let tmp: ReturnType<typeof makeTmpDir>
let vault: VaultService
let changes: VaultChange[][]
const file = (rel: string) => path.join(tmp.dir, rel)
const read = (rel: string) => fs.readFileSync(file(rel), 'utf8')

beforeEach(async () => {
  tmp = makeTmpDir('docs')
  vault = new VaultService()
  await vault.open(tmp.dir, true)
  changes = []
  vault.on('changed', (c) => changes.push(c))
})
afterEach(async () => {
  await vault.close()
  tmp.cleanup()
})

describe('保存想法', () => {
  it('写到 ideas/，记录类型和时间，不生成永久文件 ID', async () => {
    const at = new Date(2026, 10, 13, 21, 40, 5)
    const meta = await vault.createIdea({ text: '  过年要买零食  ', source: 'quick-capture', at })
    expect(meta.path).toBe('ideas/2026/11/2026-11-13 214005.md')
    const parsed = parseDoc(read(meta.path))
    expect(parsed.data).toMatchObject({ type: 'idea' })
    expect(parsed.data).not.toHaveProperty('id')
    expect(parsed.data.created).toContain('2026-11-13T21:40:05')
    expect(parsed.body).toBe('过年要买零食\n')
    expect(changes).toEqual([[{ kind: 'add', path: meta.path }]])
  })

  it('同一秒记两条不会覆盖', async () => {
    const at = new Date(2026, 10, 13, 21, 40, 5)
    const a = await vault.createIdea({ text: '一', source: 'main-window', at })
    const b = await vault.createIdea({ text: '二', source: 'main-window', at })
    expect(b.path).toBe('ideas/2026/11/2026-11-13 214005 2.md')
    expect(read(a.path)).toContain('一')
  })

  it('空内容不保存', async () => {
    await expect(vault.createIdea({ text: '   ', source: 'main-window' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fs.readdirSync(file('inbox'))).toEqual([])
  })
})

describe('读写文件', () => {
  it('读出正文、指纹、正文起始行', async () => {
    const meta = await vault.createNote({ dir: 'content', title: '读书笔记', body: '第一行\n' })
    const doc = await vault.read({ path: meta.path })
    expect(doc).toMatchObject({ type: 'note', title: '读书笔记', body: '第一行\n', bodyStartLine: 5, editable: true })
    expect(doc.hash).toBe(hashText(read(meta.path)))
  })

  it('保存正文时文件头原样保留', async () => {
    fs.writeFileSync(file('content/手写.md'), '---\n# 我的注释\ncustom:   值\ntags:\n  - a\n---\n旧正文')
    const doc = await vault.read({ path: 'content/手写.md' })
    const r = await vault.saveBody({ path: 'content/手写.md' }, '新正文\n', doc.hash)
    expect(read('content/手写.md')).toBe('---\n# 我的注释\ncustom:   值\ntags:\n  - a\n---\n新正文\n')
    expect(r.hash).toBe(hashText(read('content/手写.md')))
  })

  it('文件在别处被改过时保存返回 CONFLICT，不覆盖', async () => {
    const meta = await vault.createNote({ dir: 'content', title: 'a', body: '原文' })
    const doc = await vault.read({ path: meta.path })
    fs.writeFileSync(file(meta.path), read(meta.path).replace('原文', '外部改动'))
    await expect(vault.saveBody({ path: meta.path }, '我的改动', doc.hash)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(read(meta.path)).toContain('外部改动')
  })

  it('文本原件可以明确编辑，二进制格式不可编辑', async () => {
    fs.writeFileSync(file('content/a.txt'), '文本内容')
    fs.writeFileSync(file('content/b.pdf'), Buffer.from([1, 2, 3]))
    const txt = await vault.read({ path: 'content/a.txt' })
    expect(txt).toMatchObject({ type: 'file', body: '文本内容', editable: true })
    await vault.saveBody({ path: 'content/a.txt' }, '改过', txt.hash)
    expect(read('content/a.txt')).toBe('改过')
    expect(await vault.read({ path: 'content/b.pdf' })).toMatchObject({ type: 'file', editable: false, body: '' })
  })

  it('不存在的文件报 NOT_FOUND，软件数据目录不可访问', async () => {
    await expect(vault.read({ path: 'content/nope.md' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(vault.read({ path: '.jot/config.json' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_VAULT' })
    await expect(vault.read({ path: '../x.md' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_VAULT' })
  })

  it('路径相同的替换文件按当前内容读取', async () => {
    const meta = await vault.createNote({ title: '当前', body: '旧内容' })
    fs.writeFileSync(file(meta.path), '新文件内容')
    expect((await vault.read({ path: meta.path })).body).toBe('新文件内容')
  })

})

describe('文件头与写入权限', () => {
  it('属性补丁保留正文，不补 ID；null 删除指定键', async () => {
    fs.writeFileSync(file('content/a.md'), '正文不变\n')
    await vault.patchFrontmatter({ path: 'content/a.md' }, { tags: ['x'], place: '北京' }, 'user')
    expect(parseDoc(read('content/a.md')).data).toEqual({ tags: ['x'], place: '北京' })
    await vault.patchFrontmatter({ path: 'content/a.md' }, { place: null, tags: [] }, 'user')
    expect(parseDoc(read('content/a.md'))).toMatchObject({ data: { tags: [] }, body: '正文不变\n' })
  })

  it('文件头不合法时拒绝改写，不破坏文件', async () => {
    const bad = '---\ntags: [未闭合\n---\n正文'
    fs.writeFileSync(file('content/bad.md'), bad)
    await expect(vault.patchFrontmatter({ path: 'content/bad.md' }, { domain: '工作' }, 'user')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(read('content/bad.md')).toBe(bad)
  })

  it('流水线不能改你写的正文和原件，只能改文件头和它自己的目录', async () => {
    const idea = await vault.createIdea({ text: '想法', source: 'main-window' })
    const doc = await vault.read({ path: idea.path })
    await expect(vault.saveBody({ path: idea.path }, 'AI 改写', doc.hash, 'pipeline')).rejects.toMatchObject({ code: 'WRITE_DENIED' })
    fs.writeFileSync(file('content/a.md'), '原件')
    await vault.metadata.markImported('content/a.md', '2026-11-19T12:00:00+08:00')
    await vault.patchFrontmatter({ path: 'content/a.md' }, { tags: ['资料'] }, 'pipeline')
    expect(read('content/a.md')).toBe('原件')
    expect(read('content/a.md.meta.yaml')).toContain('资料')
    await expect(vault.patchFrontmatter({ path: idea.path }, { domain: '生活' }, 'pipeline')).resolves.toMatchObject({ path: idea.path })
    expect(read(idea.path)).toContain('想法')
    fs.writeFileSync(file('wiki/sources/s.md'), '摘要')
    const s = await vault.read({ path: 'wiki/sources/s.md' })
    await expect(vault.saveBody({ path: 'wiki/sources/s.md' }, '新摘要', s.hash, 'pipeline')).resolves.toBeTruthy()
  })
})

describe('新建、改名、移动、删除', () => {
  it('新建笔记：重名时自动加序号，名称不能带路径字符', async () => {
    const a = await vault.createNote({ dir: 'content', title: '未命名' })
    const b = await vault.createNote({ dir: 'content', title: '未命名' })
    expect([a.path, b.path]).toEqual(['content/未命名.md', 'content/未命名 2.md'])
    await expect(vault.createNote({ dir: 'content', title: 'a/b' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.createNote({ dir: '.jot', title: 'x' })).rejects.toMatchObject({ code: 'WRITE_DENIED' })
  })

  it('改名保留扩展名和内容；目标已存在时报 CONFLICT', async () => {
    const a = await vault.createNote({ dir: 'content', title: 'a' })
    await vault.createNote({ dir: 'content', title: 'b' })
    const renamed = await vault.rename({ path: a.path }, '新名字')
    expect(renamed).toMatchObject({ path: 'content/新名字.md', title: '新名字' })
    expect(fs.existsSync(file('content/a.md'))).toBe(false)
    await expect(vault.rename({ path: 'content/新名字.md' }, 'b')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(changes.at(-1)).toEqual([{ kind: 'remove', path: 'content/a.md' }, { kind: 'add', path: 'content/新名字.md' }])
  })

  it('把想法移到 content/，原记录内容保留', async () => {
    const idea = await vault.createIdea({ text: '整理过的想法', source: 'main-window' })
    const moved = await vault.move({ path: idea.path }, 'content/子目录')
    expect(moved.path).toBe('content/子目录/' + path.posix.basename(idea.path))
    expect((await vault.read({ path: moved.path })).body).toBe('整理过的想法\n')
  })

  it('删除进回收目录，可以恢复；原位置被占用时恢复成另一个名字', async () => {
    const a = await vault.createNote({ dir: 'content', title: 'a', body: '内容' })
    const { trashId } = await vault.trash({ path: a.path })
    expect(fs.existsSync(file(a.path))).toBe(false)
    const deletedAt = (await vault.trashList()).items[0]!.deletedAt
    expect(fs.existsSync(file(`.jot/trash/${deletedAt.slice(0, 4)}/${deletedAt.slice(5, 7)}/${trashId}/0-a.md`))).toBe(true)
    const restored = await vault.restore(trashId)
    expect(restored.path).toBe('content/a.md')
    expect(read('content/a.md')).toContain('内容')

    const second = await vault.trash({ path: 'content/a.md' })
    await vault.createNote({ dir: 'content', title: 'a' })
    expect((await vault.restore(second.trashId)).path).toBe('content/a 2.md')
    await expect(vault.restore('../../x')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('监听外部修改', () => {
  it('在别的程序里新增、修改、删除文件，都会收到通知', async () => {
    vault.startWatching()
    await new Promise((r) => setTimeout(r, 300))
    const seen = () => changes.flat()
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 80 && !pred(); i++) await new Promise((r) => setTimeout(r, 100))
      expect(pred()).toBe(true)
    }
    fs.writeFileSync(file('content/外部.md'), '一')
    await waitFor(() => seen().some((c) => c.kind === 'add' && c.path === 'content/外部.md'))
    fs.writeFileSync(file('content/外部.md'), '一二三')
    await waitFor(() => seen().some((c) => c.kind === 'change' && c.path === 'content/外部.md'))
    fs.unlinkSync(file('content/外部.md'))
    await waitFor(() => seen().some((c) => c.kind === 'remove' && c.path === 'content/外部.md'))
    // 软件数据目录里的变化不通知
    fs.writeFileSync(file('.jot/x.json'), '{}')
    await new Promise((r) => setTimeout(r, 800))
    expect(seen().some((c) => c.path.startsWith('.jot'))).toBe(false)
  })
})
