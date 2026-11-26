import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
const DEFAULT_FOLDERS = ['工作', '生活', '成长', '健康']
import { FIXED_DIRS } from '../../electron/vault/paths'
import { VaultService } from '../../electron/vault/vault'
import { makeTmpDir } from '../helpers/tmp'

let tmp: ReturnType<typeof makeTmpDir>
beforeEach(() => (tmp = makeTmpDir('vault')))
afterEach(() => tmp.cleanup())

describe('库服务：打开库', () => {
  it('新建库时创建全部固定目录和库级设置', async () => {
    const vault = new VaultService()
    const dir = path.join(tmp.dir, '我的库')
    const opened = await vault.open(dir, true)
    expect(opened.path).toBe(dir)
    for (const d of FIXED_DIRS) expect(fs.statSync(path.join(dir, d)).isDirectory()).toBe(true)
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.jot/config.json'), 'utf8'))
    expect(config).not.toHaveProperty('domains')
    expect(config.version).toBe(3)
    for (const legacy of ['notes', 'files', 'projects']) expect(fs.existsSync(path.join(dir, legacy))).toBe(false)
    expect(vault.status()).toEqual({ open: true, path: dir })
  })

  it('文件夹不存在且不允许新建时报 NOT_FOUND', async () => {
    const vault = new VaultService()
    await expect(vault.open(path.join(tmp.dir, 'nope'), false)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(vault.isOpen).toBe(false)
  })

  it('相对路径报 INVALID_INPUT', async () => {
    await expect(new VaultService().open('relative/dir', true)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('没打开库时访问路径报 VAULT_NOT_OPEN', () => {
    expect(() => new VaultService().path).toThrowError(expect.objectContaining({ code: 'VAULT_NOT_OPEN' }))
  })

  it('打开已有的库时保留已有文件和领域设置，并补齐缺失的目录', async () => {
    const dir = path.join(tmp.dir, 'v')
    const first = new VaultService()
    await first.open(dir, true)
    await first.createFolder('content', '家庭')
    await fs.promises.rmdir(path.join(dir, 'content/健康'))
    fs.writeFileSync(path.join(dir, 'content/a.md'), '内容')
    fs.rmdirSync(path.join(dir, 'journal'))

    const second = new VaultService()
    await second.open(dir, false)
    expect((await second.directories()).map(item => item.name).sort()).toEqual(['工作', '生活', '成长', '家庭'].sort())
    expect(fs.existsSync(path.join(dir, 'content/健康'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'content/a.md'), 'utf8')).toBe('内容')
    expect(fs.existsSync(path.join(dir, 'journal'))).toBe(true)
  })

  it('目录树不包含软件数据目录，目录排在文件前面', async () => {
    const vault = new VaultService()
    await vault.open(tmp.dir, true)
    fs.writeFileSync(path.join(tmp.dir, 'content/b.md'), '')
    fs.mkdirSync(path.join(tmp.dir, 'content/子目录'))
    fs.writeFileSync(path.join(tmp.dir, 'content/子目录/c.md'), '')
    const tree = await vault.tree()
    expect(tree.map((n) => n.name)).not.toContain('.jot')
    const content = tree.find((n) => n.name === 'content')!
    expect(content.children!.filter(n => !DEFAULT_FOLDERS.includes(n.name)).map(n => [n.kind, n.path])).toEqual([
      ['dir', 'content/子目录'], ['file', 'content/b.md'],
    ])
    expect(content.children!.at(-1)!.kind).toBe('file')
    expect(content.children!.find(n => n.path === 'content/子目录')!.children![0]!.path).toBe('content/子目录/c.md')
  })
})

it('旧业务目录尚未整理时拒绝打开，不偷偷创建并行结构或改旧设置', async () => {
  const dir = path.join(tmp.dir, 'legacy')
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.jot'))
  const config = '{"version":1,"domains":["工作"]}'
  fs.writeFileSync(path.join(dir, '.jot/config.json'), config)
  const vault = new VaultService()
  await expect(vault.open(dir, false)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(vault.isOpen).toBe(false)
  expect(fs.existsSync(path.join(dir, 'content'))).toBe(false)
  expect(fs.readFileSync(path.join(dir, '.jot/config.json'), 'utf8')).toBe(config)
})

it('旧目录名不能再作为笔记或导入的写入目标', async () => {
  const vault = new VaultService()
  await vault.open(tmp.dir, true)
  try {
    const source = path.join(tmp.dir, '..', path.basename(tmp.dir) + '-outside.md')
    fs.writeFileSync(source, '原文')
    try {
      for (const legacy of ['notes', 'files', 'projects']) {
        await expect(vault.createNote({ dir: legacy, title: '误写' })).rejects.toMatchObject({ code: 'WRITE_DENIED' })
        await expect(vault.importFile(source, legacy)).rejects.toMatchObject({ code: 'WRITE_DENIED' })
        expect(fs.existsSync(path.join(tmp.dir, legacy))).toBe(false)
      }
      expect((await vault.createNote({ title: '默认笔记' })).path).toMatch(/^inbox\/\d{4}\/\d{2}\/默认笔记\.md$/)
    } finally { fs.unlinkSync(source) }
  } finally { await vault.close() }
})
