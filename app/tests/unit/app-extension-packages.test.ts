import { describe, expect, it } from 'vitest'
import { appExtensionManifest } from '../../electron/extensions/schema'
import { inspectAppExtension, parseAppExtension } from '../../electron/extensions/packages'
import { compareVersions } from '../../electron/extensions/versions'
import type { PackageEntry } from '../../electron/vault/package-files'

const manifest = {
  schemaVersion: 1, apiVersion: 1, id: 'test-diary', name: '测试日记', version: '1.0.0', description: '测试包', minAppVersion: '0.1.0',
  commands: [{ id: 'today', name: '今日日记', icon: 'book-open', action: 'daily-note', defaults: { directory: null, filename: '{{yyyy}}-{{MM}}-{{dd}}.md', template: { kind: 'package', path: 'templates/default.md' } } }],
}
const entries = (): PackageEntry[] => [
  { path: 'extension.json', data: Buffer.from(JSON.stringify(manifest)) },
  { path: 'templates', data: null },
  { path: 'templates/default.md', data: Buffer.from('# 虚构日记\n') },
]

describe('应用插件包校验', () => {
  it('独立清单与实际模板通过，UTF-8 BOM 可解析，不接收 AI 或脚本清单', () => {
    expect(parseAppExtension('\uFEFF' + JSON.stringify(manifest))).toEqual(manifest)
    expect(inspectAppExtension(entries(), '0.1.0')).toEqual({ manifest, issues: [] })
    expect(() => parseAppExtension('invalid')).toThrow('有效的 JSON')
    expect(() => parseAppExtension(JSON.stringify({ id: 'ai', agents: [], skills: [] }))).toThrow('extension.json')
    expect(() => parseAppExtension(JSON.stringify({ ...manifest, main: 'plugin.js' }))).toThrow('extension.json')
  })

  it('最低应用版本、缺失模板及非法编码返回具体依赖诊断', () => {
    const newer = entries()
    newer[0]!.data = Buffer.from(JSON.stringify({ ...manifest, minAppVersion: '1.10.0' }))
    expect(inspectAppExtension(newer, '1.9.0').issues).toEqual(['需要 Jot 1.10.0 或更高版本，当前为 1.9.0'])
    expect(inspectAppExtension(entries().slice(0, 2), '0.1.0').issues).toEqual(['缺少声明的模板：templates/default.md'])
    const binary = entries()
    binary[2]!.data = Buffer.from([0xff, 0xfe])
    expect(inspectAppExtension(binary, '0.1.0').issues[0]).toContain('UTF-8')
  })

  it('包路径、大小和数量受现有通用包规则约束', () => {
    for (const value of [
      [...entries(), { path: '../outside.md', data: Buffer.from('越界') }],
      [...entries(), { path: 'extension.json', data: Buffer.from('{}') }],
      [...entries(), { path: 'templates/default.md/sub.md', data: Buffer.from('文件不能作为目录') }],
      [...entries(), { path: 'assets/large.bin', data: Buffer.alloc(32 * 1024 * 1024) }],
      [...entries(), ...Array.from({ length: 1000 }, (_, index) => ({ path: `assets/${index}.md`, data: null }))],
    ]) expect(() => inspectAppExtension(value, '0.1.0')).toThrow()
  })

  it('包标识与物理目录约束一致，不沿用 AI 标识长度限制', () => {
    expect(appExtensionManifest.safeParse({ ...manifest, id: 'a'.repeat(80) }).success).toBe(true)
    for (const id of ['core', 'con', 'lpt1', 'nul', '../outside', 'a'.repeat(81)]) {
      expect(appExtensionManifest.safeParse({ ...manifest, id }).success).toBe(false)
    }
  })
})

describe('应用版本比较', () => {
  it.each([
    ['0.1.0', '0.1.0', 0], ['1.10.0', '1.9.0', 1], ['2.0.0', '10.0.0', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1], ['1.0.0-beta', '1.0.0', -1],
    ['1.0.0', '1.0.0-beta', 1], ['1.0.0+build.1', '1.0.0+other', 0],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0-1', '1.0.0-alpha', -1],
    ['999999999999999999999.0.0', '999999999999999999998.0.0', 1],
  ])('%s 与 %s 的比较结果为 %i', (first, second, expected) => {
    expect(compareVersions(first, second)).toBe(expected)
  })
})
