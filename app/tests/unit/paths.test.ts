import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { JotError } from '@shared/result'
import { isInMeta, normalizeRel, resolveInVault, toRel } from '../../electron/vault/paths'

const root = path.resolve('/tmp/vault')

describe('库内路径', () => {
  it('把反斜杠、多余的斜杠规范成正斜杠相对路径', () => {
    expect(normalizeRel('inbox\\a.md')).toBe('inbox/a.md')
    expect(normalizeRel('/notes//x/../y.md/')).toBe('notes/y.md')
    expect(normalizeRel('.')).toBe('')
  })

  it('库内路径解析成绝对路径，并能转回相对路径', () => {
    const abs = resolveInVault(root, 'inbox/a.md')
    expect(abs).toBe(path.join(root, 'inbox', 'a.md'))
    expect(toRel(root, abs)).toBe('inbox/a.md')
  })

  it.each(['../outside.md', 'notes/../../x.md', 'C:\\Windows\\x.txt', '/etc/passwd/../../..'])('拒绝越出库的路径：%s', (rel) => {
    try {
      resolveInVault(root, rel)
      expect.unreachable('应该抛出错误')
    } catch (e) {
      expect(e).toBeInstanceOf(JotError)
      expect((e as JotError).code).toBe('PATH_OUTSIDE_VAULT')
    }
  })

  it('识别软件数据目录', () => {
    expect(isInMeta('.jot')).toBe(true)
    expect(isInMeta('.jot/index.db')).toBe(true)
    expect(isInMeta('.jotx/a')).toBe(false)
    expect(isInMeta('notes/.jot')).toBe(false)
  })
})
