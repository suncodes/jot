import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentFiles, type ConfirmFiles } from '../../electron/agent/files'
import { sidecarPath } from '../../electron/vault/metadata'
import { deferred, testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
let files: AgentFiles
const file = 'content/工作/规则.md'
const approve: ConfirmFiles = async () => true
const refuse: ConfirmFiles = async () => false
beforeEach(async () => {
  app = await testApp()
  files = new AgentFiles({ operations: () => app.core.operations, vault: app.core.vault, index: app.core.index, mutate: op => app.core.mutate(op), changed: () => app.core.idle(),
    moved: paths => app.core.agent.moveReferences(paths), trashed: paths => { app.core.jobs.cancelTargets(paths); for (const p of paths) app.core.state.removeSuggestion(p) } })
  app.write(file, '---\ncustom: 原属性\ntags: [业务]\n---\n第一段规则。\n\n第二段原文。\n')
  await app.core.syncIndex()
})
afterEach(async () => { vi.restoreAllMocks(); await app.close() })

describe('明确路径文件操作', () => {
  it('新建目录和文本后即可读取；不写文件 ID，重复目标不覆盖', async () => {
    await files.mkdir('content/工作', '资料')
    const result = await files.write([{ path: 'content/工作/资料/新笔记.md', body: '新笔记内容\n' }], refuse)
    expect(result).toEqual({ updated: ['content/工作/资料/新笔记.md'], failed: [] })
    const doc = await files.read(result.updated[0]!, {})
    expect(doc.body).toBe('新笔记内容\n')
    expect(doc.properties).not.toHaveProperty('id')
    await expect(app.core.vault.createText(doc.path, '不应覆盖')).rejects.toThrow('目标已存在')
    expect((await files.read(doc.path, {})).body).toBe(doc.body)
  })

  it('局部唯一匹配保留空白；不匹配和多重匹配均要求重读，不能静默覆盖', async () => {
    const edited = '  新规则。\n'
    await files.edit(file, '第一段规则。\n', edited, refuse)
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain(edited + '\n第二段原文。')
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain('custom: 原属性')
    await expect(files.edit(file, '第一段规则。', '不存在', approve)).rejects.toThrow('请重新读取')
    app.write(file, '重复\n重复')
    await expect(files.edit(file, '重复', '一次', approve)).rejects.toThrow('未唯一匹配')
    expect(fs.readFileSync(app.file(file), 'utf8')).toBe('重复\n重复')
  })

  it('大部分正文替换需要确认，即使文件很短；局部匹配失败后可重读再改', async () => {
    app.write(file, '全部旧正文')
    const confirm = vi.fn(refuse)
    await expect(files.edit(file, '全部旧正文', '新正文', confirm)).rejects.toThrow('未同意替换')
    expect(confirm).toHaveBeenCalledOnce()
    expect(fs.readFileSync(app.file(file), 'utf8')).toBe('全部旧正文')
    await files.edit(file, (await files.read(file, {})).body, '新正文', approve)
    expect(fs.readFileSync(app.file(file), 'utf8')).toBe('新正文')
  })

  it('属性只改给出字段；二进制及导入 Markdown 属性写附属文件，原字节不变', async () => {
    app.core.state.setSuggestion(file, { kind: 'properties', properties: { tags: ['候选'], place: '北京' }, confidence: 0.8, reason: '' })
    await files.properties(file, { tags: ['新标签'], people: ['小林'] })
    expect(app.core.state.getSuggestion(file, 'properties')).toMatchObject({ properties: { place: '北京' } })
    expect(app.core.state.getSuggestion(file, 'properties')).not.toHaveProperty('properties.tags')
    expect((await files.read(file, {})).properties).toMatchObject({ custom: '原属性', tags: ['新标签'], people: ['小林'] })
    const binary = Buffer.from([0, 1, 2, 255])
    app.write('content/工作/附件.pdf', binary)
    await files.properties('content/工作/附件.pdf', { tags: ['附件'], custom: '自定义' })
    expect(fs.readFileSync(app.file('content/工作/附件.pdf'))).toEqual(binary)
    expect(fs.readFileSync(app.file(sidecarPath('content/工作/附件.pdf')), 'utf8')).toContain('自定义')
    const raw = '---\ncustom: 原稿\n---\n原件内容'
    app.write('content/工作/原稿.md', raw)
    app.write(sidecarPath('content/工作/原稿.md'), 'kind: attachment\n')
    await files.properties('content/工作/原稿.md', { tags: ['导入'] })
    expect(fs.readFileSync(app.file('content/工作/原稿.md'), 'utf8')).toBe(raw)
  })

  it('移动文件和附属文件并维护普通链接，索引与实际返回路径一致；目标冲突失败', async () => {
    const source = 'content/工作/附件.txt', target = 'content/工作/资料/附件新版.txt'
    app.write(source, '原件内容')
    await files.properties(source, { tags: ['附件'] })
    app.write('content/工作/链接.md', '[附件](附件.txt)')
    await app.core.syncIndex()
    const result = await files.move(source, target)
    expect(result.paths).toEqual(expect.arrayContaining([{ from: source, to: target }]))
    expect(fs.existsSync(app.file(sidecarPath(target)))).toBe(true)
    expect(decodeURIComponent(fs.readFileSync(app.file('content/工作/链接.md'), 'utf8'))).toContain('资料/附件新版.txt')
    expect(app.core.index.getDoc(target)).toBeTruthy()
    expect(app.core.index.getDoc(source)).toBeNull()
    await expect(files.move(target, file)).rejects.toThrow('目标文件或附属属性已存在')
    expect(fs.readFileSync(app.file(target), 'utf8')).toBe('原件内容')
  })

  it('批量覆盖逐个返回真实成功或失败，不把部分失败当全部成功', async () => {
    const second = 'content/工作/二.md'
    app.write(second, '二')
    const real = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === app.file(second)) throw new Error('模拟文件被占用')
      return real(from, to)
    })
    const result = await files.write([{ path: file, body: '已更新' }, { path: second, body: '未更新' }], approve)
    expect(result.updated).toEqual([file])
    expect(result.failed).toEqual([{ path: second, message: '模拟文件被占用' }])
    expect(fs.readFileSync(app.file(second), 'utf8')).toBe('二')
  })

  it('等待覆盖确认时新建目标被占用，整批不继续以新建名义覆盖', async () => {
    const arrived = deferred(), decision = deferred(), created = 'content/工作/新建.md'
    const pending = files.write([{ path: file, body: '已有目标' }, { path: created, body: '计划新建' }], async () => { arrived.release(); await decision.promise; return true })
    await arrived.promise
    app.write(created, '用户刚创建')
    decision.release()
    await expect(pending).rejects.toThrow('新建目标已存在')
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain('第一段规则')
    expect(fs.readFileSync(app.file(created), 'utf8')).toBe('用户刚创建')
  })

  it('整篇覆盖写入完整原文，不隐式保留旧属性或建立旧版本准入', async () => {
    const arrived = deferred(), decision = deferred()
    const pending = files.write([{ path: file, body: '明确替换后的正文' }], async () => { arrived.release(); await decision.promise; return true })
    await arrived.promise
    await app.core.vault.patchFrontmatter({ path: file }, { custom: '用户等待时修改' }, 'user')
    decision.release()
    await pending
    expect(fs.readFileSync(app.file(file), 'utf8')).toBe('明确替换后的正文')
    expect((await files.read(file, {})).body).toBe('明确替换后的正文')
  })
  it('停止批量写入保留已完成项，并逐项报告剩余目标未执行', async () => {
    const controller = new AbortController()
    const real = fs.promises.writeFile
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      await real(file, data, options)
      if (String(file) === app.file('content/工作/一.md')) controller.abort()
    })
    const result = await files.write([{ path: 'content/工作/一.md', body: '已完成' }, { path: 'content/工作/二.md', body: '不应写入' }], approve, controller.signal)
    expect(result.updated).toEqual(['content/工作/一.md'])
    expect(result.failed).toEqual([{ path: 'content/工作/二.md', message: '操作已停止' }])
    expect(fs.existsSync(app.file('content/工作/二.md'))).toBe(false)
  })

  it('新建目标已有孤立附属文件时不静默接管其属性', async () => {
    const target = 'content/工作/孤立.md'
    app.write(sidecarPath(target), 'kind: attachment\ntags: [旧资料]')
    const result = await files.write([{ path: target, body: '新笔记' }], approve)
    expect(result.updated).toEqual([])
    expect(result.failed[0]!.message).toContain('同名附属属性')
    expect(fs.existsSync(app.file(target))).toBe(false)
    expect(fs.readFileSync(app.file(sidecarPath(target)), 'utf8')).toContain('旧资料')
  })

})

describe('回收与操作边界', () => {
  it('目录回收列全实际成员，外部摘要保留；恢复实际文件和目录', async () => {
    const dir = 'content/工作/资料'
    app.write(dir + '/子目录/数据.txt', '数据')
    await files.properties(dir + '/子目录/数据.txt', { tags: ['附件'] })
    app.write('wiki/sources/摘要.md', '---\ntype: source-summary\nsource: content/工作/资料/子目录/数据.txt\n---\n已生成摘要')
    const confirm = vi.fn(approve)
    const result = await files.trash([dir, dir + '/子目录/数据.txt'], confirm)
    expect(result).toHaveLength(1)
    expect(confirm).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([
      { path: dir, action: 'trash' }, { path: dir + '/子目录', action: 'trash' },
      { path: dir + '/子目录/数据.txt', action: 'trash' }, { path: sidecarPath(dir + '/子目录/数据.txt'), action: 'trash' },
    ]))
    expect(fs.existsSync(app.file(dir))).toBe(false)
    expect(fs.existsSync(app.file('wiki/sources/摘要.md'))).toBe(true)
    await app.call('folder:restore', { trashId: result[0]!.trashId! })
    expect(fs.readFileSync(app.file(dir + '/子目录/数据.txt'), 'utf8')).toBe('数据')
  })

  it('确认期间回收目录多出新成员，要求重新列目标；没有偷偷扩大删除', async () => {
    const dir = 'content/工作/待回收'
    app.write(dir + '/旧.md', '旧')
    const arrived = deferred(), decision = deferred()
    const pending = files.trash([dir], async () => { arrived.release(); await decision.promise; return true })
    await arrived.promise
    app.write(dir + '/刚加入.md', '保留')
    decision.release()
    await expect(pending).rejects.toThrow('目标列表已变化')
    expect(fs.readFileSync(app.file(dir + '/刚加入.md'), 'utf8')).toBe('保留')
    expect(fs.existsSync(app.file(dir + '/旧.md'))).toBe(true)
  })

  it('拒绝或已停止的回收不触碰实际文件', async () => {
    await expect(files.trash([file], refuse)).rejects.toThrow('用户取消')
    const controller = new AbortController()
    controller.abort()
    await expect(files.trash([file], approve, controller.signal)).rejects.toThrow('操作已停止')
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain('第一段规则')
  })

  it.each(['../外部.md', '.jot/state.db', 'content/工作/规则.md.meta.yaml'])('禁止直接读取或写入：%s', async rel => {
    await expect(files.read(rel, {})).rejects.toThrow()
    await expect(files.write([{ path: rel, body: '不允许' }], approve)).rejects.toThrow()
  })

  it('符号链接不能绕过库内内容边界，包括指向内部 .jot 的 junction', async () => {
    const link = app.file('content/内部链接')
    fs.symlinkSync(app.file('.jot'), link, 'junction')
    try {
      await expect(files.read('content/内部链接/state.db', {})).rejects.toThrow('专用管理操作')
      await expect(files.write([{ path: 'content/内部链接/越权.md', body: '不能写' }], approve)).rejects.toThrow('专用管理操作')
      expect((await files.list('content')).some(row => row.path === 'content/内部链接')).toBe(false)
    } finally { fs.unlinkSync(link) }
  })
})

describe('统一磁盘文件工具', () => {
  const slash = (value: string) => value.replace(/\\/g, '/')
  const external = (...parts: string[]) => path.join(app.tmp.dir, 'external', ...parts)
  const put = (file: string, body: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body) }

  it('库内绝对路径与相对路径使用同一身份；读取和编辑完整原文，包括frontmatter、BOM及CRLF', async () => {
    const raw = '\ufeff---\r\ncustom: 保留原样\r\n---\r\n  正文一。\r\n正文二。\r\n'
    app.write(file, raw)
    const doc = await files.read(app.file(file), {})
    expect(doc).toMatchObject({ path: file, body: raw, bodyStartLine: 1 })
    await files.edit(app.file(file), 'custom: 保留原样', 'custom: 已修改', refuse)
    expect(fs.readFileSync(app.file(file), 'utf8')).toBe(raw.replace('保留原样', '已修改'))
    await expect(files.write([{ path: file, body: '一' }, { path: app.file(file), body: '二' }], approve)).rejects.toThrow('不能重复')
    expect(app.core.index.getDoc(file)?.properties?.custom).toBe('已修改')
  })

  it('库外文本可创建、分页读取、唯一匹配编辑、全文覆盖、查找和搜索；默认查找仍只在库内', async () => {
    const root = external('项目'), target = path.join(root, 'notes', '说明.md')
    expect(await files.mkdir(root, 'notes')).toEqual({ path: slash(path.join(root, 'notes')) })
    const raw = '---\ncustom: 外部原属性\n---\n外部独有关键词\n' + '长文内容。'.repeat(2000) + '\n结束'
    expect(await files.write([{ path: target, body: raw }], refuse)).toEqual({ updated: [slash(target)], failed: [] })
    const doc = await files.read(target, {})
    expect(doc.body).toBe(raw)
    const first = files.page(doc), pages = [first.text]
    let cursor = first.next
    while (cursor) { const page = files.page(doc, cursor); pages.push(page.text); cursor = page.next }
    expect(pages.join('')).toBe(raw)
    const find = await files.find({ directory: root, pattern: '*.md' }, {})
    expect(find.items).toEqual([{ path: slash(target) }])
    const grep = await files.find({ directory: root, query: '外部独有关键词' }, {})
    expect(grep.items).toEqual([{ path: slash(target), line: 4, text: '外部独有关键词' }])
    await files.edit(target, '外部独有关键词', '已修改外部关键词', refuse)
    expect(fs.readFileSync(target, 'utf8')).toBe(raw.replace('外部独有关键词', '已修改外部关键词'))
    const confirm = vi.fn(approve)
    expect((await files.write([{ path: target, body: '明确整篇替换' }], confirm)).updated).toEqual([slash(target)])
    expect(confirm).toHaveBeenCalledWith(expect.any(String), [{ path: slash(target), action: 'overwrite' }])
    expect(fs.readFileSync(target, 'utf8')).toBe('明确整篇替换')
    expect((await files.find({ query: '外部关键词' }, {})).items).toEqual([])
    expect(app.core.index.allPaths()).not.toContain(slash(target))
    expect((await files.list()).every(row => !path.isAbsolute(row.path))).toBe(true)
    await expect(files.properties(target, { tags: ['外部'] })).rejects.toThrow('库内内容')
  })

  it('库外代码、隐藏文件和无扩展名配置按UTF-8原文处理，二进制不能误读或覆盖', async () => {
    for (const name of ['index.ts', '.config', 'Makefile']) {
      const target = external(name)
      expect((await files.write([{ path: target, body: 'const value = 1;\n' }], refuse)).failed).toEqual([])
      expect((await files.read(target, {})).body).toBe('const value = 1;\n')
    }
    const binary = external('binary.data'), bytes = Buffer.from([0, 255, 2])
    put(binary, bytes)
    await expect(files.read(binary, {})).rejects.toThrow('UTF-8')
    await expect(files.write([{ path: binary, body: '不能破坏原字节' }], approve)).rejects.toThrow()
    expect(fs.readFileSync(binary)).toEqual(bytes)
    expect((await files.list(external())).map(row => path.basename(row.path))).toContain('.config')
  })

  it('材料限制对库外同样有效，显式外部目录允许自己的子树，不能绕过到其他文件', async () => {
    const one = external('selected', 'one.txt'), two = external('other', 'two.txt')
    put(one, '指定材料'); put(two, '范围外文件')
    const filter = { materials: [{ kind: 'folder' as const, value: external('selected') }] }
    expect((await files.read(one, filter)).body).toBe('指定材料')
    await expect(files.read(two, filter)).rejects.toThrow('超出本轮限定材料')
    expect((await files.find({ directory: external(), pattern: '*.txt' }, filter)).items).toEqual([{ path: slash(one) }])
    await expect(files.read(one, { materials: [{ kind: 'file', value: file }] })).rejects.toThrow('超出本轮限定材料')
  })

  it('库外文件和目录可改名移动；跨库移动不复制存留，入库更新索引，出库移除索引', async () => {
    const source = external('原件', '材料.txt'), renamed = external('改名', '材料新版.txt')
    put(source, '跨目录原件')
    expect(await files.move(source, renamed)).toMatchObject({ path: slash(renamed), notUpdated: [] })
    expect(fs.existsSync(source)).toBe(false)
    await files.move(external('改名'), external('最终目录'))
    const final = external('最终目录', '材料新版.txt')
    expect(fs.readFileSync(final, 'utf8')).toBe('跨目录原件')
    const inside = 'content/工作/归档.txt'
    await files.move(final, app.file(inside))
    expect(app.core.index.getDoc(inside)).toBeTruthy()
    await files.properties(inside, { tags: ['迁入'] })
    const outside = external('重新迁出.txt')
    const out = await files.move(inside, outside)
    expect(out.notUpdated[0]?.message).toContain('未改写')
    expect(app.core.index.getDoc(inside)).toBeNull()
    expect(fs.existsSync(app.file(inside))).toBe(false)
    expect(fs.readFileSync(outside, 'utf8')).toBe('跨目录原件')
    expect(fs.readFileSync(sidecarPath(outside), 'utf8')).toContain('迁入')
    const collision = external('已有.txt')
    put(collision, '原有')
    await expect(files.move(outside, collision)).rejects.toThrow('已存在')
    expect(fs.readFileSync(collision, 'utf8')).toBe('原有')
  })

  it('库外回收先集中确认，调用系统回收站并逐项返回真实结果；取消和根目录受保护', async () => {
    const dir = external('待回收'), target = path.join(dir, '文件.txt')
    put(target, '外部回收数据')
    const trash = vi.spyOn(app.platform, 'trashItem')
    await expect(files.trash([dir], refuse)).rejects.toThrow('用户取消')
    expect(trash).not.toHaveBeenCalled()
    const confirm = vi.fn(approve)
    expect(await files.trash([dir], confirm)).toEqual([{ path: slash(dir), recycled: true }])
    expect(confirm).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([{ path: slash(dir), action: 'trash' }, { path: slash(target), action: 'trash' }]))
    expect(trash).toHaveBeenCalledWith(dir)
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.readFileSync(path.join(app.tmp.dir, 'system-trash', '待回收', '文件.txt'), 'utf8')).toBe('外部回收数据')
    await expect(files.trash([app.tmp.dir], approve)).rejects.toThrow('固定根目录')
    await expect(files.move(app.root, external('不应移动笔记库'))).rejects.toThrow('固定根目录')
  })

  it('显式junction可访问外部文件；递归扫描不跟随链接，并且不能绕过.jot边界', async () => {
    const directory = external('链接目标')
    put(path.join(directory, '材料.md'), '链接读取内容')
    const link = app.file('content/外部链接')
    fs.symlinkSync(directory, link, 'junction')
    try {
      expect((await files.read('content/外部链接/材料.md', {})).body).toBe('链接读取内容')
      expect((await files.list('content')).some(row => row.path.includes('外部链接'))).toBe(false)
      const selected = { materials: [{ kind: 'folder' as const, value: directory }] }
      expect((await files.read('content/外部链接/材料.md', selected)).path).toBe(slash(path.join(directory, '材料.md')))
    } finally { fs.unlinkSync(link) }
  })
})

describe('跨磁盘和系统回收结果', () => {
  it('跨磁盘移动回退到复制后删除，保留子目录、二进制字节和空目录', async () => {
    const source = path.join(app.tmp.dir, 'external-source'), target = path.join(app.tmp.dir, 'external-target')
    const bytes = Buffer.from([0, 255, 23, 99])
    fs.mkdirSync(path.join(source, '空目录'), { recursive: true })
    fs.mkdirSync(path.join(source, '子目录'))
    fs.writeFileSync(path.join(source, '子目录', '附件.bin'), bytes)
    const rename = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === source) throw Object.assign(new Error('跨磁盘'), { code: 'EXDEV' })
      return rename(from, to)
    })
    await files.move(source, target)
    expect(fs.existsSync(source)).toBe(false)
    expect(fs.statSync(path.join(target, '空目录')).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(target, '子目录', '附件.bin'))).toEqual(bytes)
  })

  it('系统回收失败不报成功，其他实际成功项独立保留', async () => {
    const one = path.join(app.tmp.dir, '拒绝回收.txt'), two = path.join(app.tmp.dir, '可以回收.txt')
    fs.writeFileSync(one, '保留'); fs.writeFileSync(two, '可恢复')
    vi.spyOn(app.platform, 'trashItem').mockRejectedValueOnce(new Error('系统回收站暂不可用'))
    const result = await files.trash([one, two], approve)
    expect(result).toEqual([{ path: one.replace(/\\/g, '/'), error: '系统回收站暂不可用' }, { path: two.replace(/\\/g, '/'), recycled: true }])
    expect(fs.readFileSync(one, 'utf8')).toBe('保留')
    expect(fs.existsSync(two)).toBe(false)
  })
})

describe('写入后的定向回读', () => {
  it('新建后磁盘内容发生变化时不报告成功，不自动回滚或覆盖其他修改', async () => {
    const target = 'content/工作/回读不一致.md'
    const original = fs.promises.writeFile
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      await original(file, data, options)
      if (String(file) === app.file(target)) fs.writeFileSync(app.file(target), '外部程序紧接着修改的内容')
    })
    const result = await files.write([{ path: target, body: '本次计划写入' }], approve)
    expect(result.updated).toEqual([])
    expect(result.failed).toEqual([{ path: target, message: expect.stringContaining('回读内容与本次写入不一致') }])
    expect(fs.readFileSync(app.file(target), 'utf8')).toBe('外部程序紧接着修改的内容')
    expect(app.core.index.getDoc(target)).toBeTruthy()
  })

  it('局部编辑保存后若回读失败，返回真实失败而不悄悄重写', async () => {
    const original = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await original(from, to)
      if (String(to) === app.file(file)) fs.writeFileSync(app.file(file), '保存后的其他修改')
    })
    await expect(files.edit(file, '第一段规则。', '第一段新规则。', approve)).rejects.toThrow('回读内容与本次写入不一致')
    expect(fs.readFileSync(app.file(file), 'utf8')).toBe('保存后的其他修改')
  })

  it('库外文件保存后不可回读时报告未核验，不把写入当作已回滚', async () => {
    const outside = path.join(app.tmp.dir, '外部回读.txt'), original = fs.promises.readFile
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, options) => {
      if (String(file) === outside) throw new Error('模拟回读被占用')
      return original(file, options)
    })
    const result = await files.write([{ path: outside, body: '已经落盘的原文' }], approve)
    expect(result.updated).toEqual([])
    expect(result.failed[0]?.message).toContain('文件已写入，但回读失败')
    expect(fs.readFileSync(outside, 'utf8')).toBe('已经落盘的原文')
  })
})
