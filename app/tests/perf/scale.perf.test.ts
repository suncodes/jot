import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IndexService } from '../../electron/index/index'
import { ContentService } from '../../electron/content/scope'
import { VaultService } from '../../electron/vault/vault'
import type { LibrarySource } from '../../shared/types'
import { makeTmpDir } from '../helpers/tmp'

// 需求文档 N07：按几万条记录、几千份文件设计，搜索响应在 1 秒以内。
const IDEAS = Number(process.env.JOT_PERF_IDEAS ?? 30000)
const FILES = Number(process.env.JOT_PERF_FILES ?? 3000)

const WORDS = ['过年', '零食', '需求评审', '接口文档', '指纹解锁', '临时密码', '跑步', '读书笔记', '净水器', '预算', '供应商', '周报', '数据库迁移', '电池续航', '年货', '体检', '绩效', '装修', '车票', '会议纪要']
const pick = <T>(list: T[], seed: number) => list[seed % list.length]!
const sentence = (seed: number, n: number) => Array.from({ length: n }, (_, k) => pick(WORDS, seed * 7 + k * 13 + (seed >> 3))).join('，')

describe('规模', () => {
  let tmp: ReturnType<typeof makeTmpDir>
  let index: IndexService
  let indexMs = 0
  let vault: VaultService
  const sources: LibrarySource[] = []

  beforeAll(async () => {
    tmp = makeTmpDir('perf')
    index = new IndexService()
    index.open(path.join(tmp.dir, 'index.db'))
    vault = new VaultService()
    await vault.open(path.join(tmp.dir, 'vault'), true)
    await vault.createFolder('content/工作', '资料')
    index.setContentQueries(new ContentService(vault, index, () => sources))
    const started = performance.now()
    for (let i = 0; i < IDEAS; i++) {
      const day = `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`
      const text = `---\ntype: idea\ncreated: ${day}T10:00:00+08:00\ntags: [${pick(WORDS, i)}, ${pick(WORDS, i + 5)}]\n---\n第 ${i} 条想法：${sentence(i, 6)}。\n`
      index.upsert({ path: `ideas/${day.slice(0, 4)}/${day.slice(5, 7)}/${day} ${String(i).padStart(6, '0')}.md`, text, mtimeMs: i, size: text.length, birthtime: new Date(), mtime: new Date() })
    }
    for (let i = 0; i < FILES; i++) {
      // 每份文件十几段，约 3000 字
      const text = Array.from({ length: 14 }, (_, k) => `## 第 ${k + 1} 节\n${sentence(i * 31 + k, 30)}。`).join('\n\n')
      index.upsert({ path: `content/工作/资料/文件${i}.txt`, text, mtimeMs: i, size: text.length, birthtime: new Date(), mtime: new Date() })
    }
    indexMs = performance.now() - started
  })
  afterAll(async () => {
    await vault.close()
    index.close()
    tmp.cleanup()
  })

  it(`${IDEAS} 条想法加 ${FILES} 份文件：各种查询都在 1 秒以内`, () => {
    const chunks = index.count()
    const rows: string[] = []
    /** 每种查询跑三次取中间值 */
    const measure = (label: string, fn: () => unknown) => {
      const times = [0, 1, 2].map(() => {
        const t = performance.now()
        fn()
        return performance.now() - t
      }).sort((a, b) => a - b)
      rows.push(`${label}：${times[1]!.toFixed(0)} 毫秒`)
      return times[1]!
    }
    const results = [
      measure('四个字的词（全文索引）', () => index.search({ text: '需求评审' })),
      measure('两个字的词（子串匹配）', () => index.search({ text: '过年' })),
      measure('一个字', () => index.search({ text: '锁' })),
      measure('两个词都要出现', () => index.search({ text: '指纹解锁 预算' })),
      measure('关键词加筛选（标签、时间）', () => index.search({ text: '接口文档', filter: { tags: ['需求'], from: '2026-03-01', to: '2026-06-30' } })),
      measure('只筛选不输关键词', () => index.search({ filter: { tags: ['零食'] }, limit: 50 })),
      measure('按时间排序', () => index.search({ text: '临时密码', sort: 'time' })),
      measure('放宽查找（助手用）', () => index.search({ text: '智能门锁二期 功能规划', mode: 'any' })),
      measure('没有结果的查询', () => index.search({ text: '完全不存在的词语' })),
      measure('某一天的时间线', () => index.timeline('2026-06-15', '2026-06-15')),
      measure('按标签统计', () => index.stats('tag')),
      measure('目录材料查询', () => index.search({ filter: { materials: [{ kind: 'folder', value: 'content/工作' }] } })),
      measure('按名称打开文件', () => index.quickOpen('文件12')),
    ]
    console.log(`\n${IDEAS + FILES} 个文件（${IDEAS} 条想法、${FILES} 份文件），建索引用了 ${(indexMs / 1000).toFixed(1)} 秒，平均每个 ${(indexMs / (IDEAS + FILES)).toFixed(2)} 毫秒；文件数 ${chunks}\n` + rows.join('\n'))
    expect(index.search({ text: '需求评审' }).total).toBeGreaterThan(Math.floor(IDEAS / 30))
    for (const ms of results) expect(ms).toBeLessThan(1000)
  })
  it('统一内容库按当前样本合并原件和摘要，再分页和筛选', () => {
    const stamp = new Date('2026-11-16T12:00:00+08:00')
    for (let i = 0; i < FILES; i++) {
      const source = 'content/工作/资料/文件' + i + '.txt'
      const summaryPath = 'wiki/sources/摘要' + i + '.md'
      const text = '---\ntype: source-summary\nsource: "[[' + source + ']]"\n---\n摘要方案：' + sentence(i, 4)
      index.upsert({ path: summaryPath, text, mtimeMs: i + 1, size: text.length, birthtime: stamp, mtime: stamp })
      sources.push({ path: source, summaryPath, state: 'done', size: 3000, text: true, missing: false, classification: index.getDoc(source)!.classification, addedAt: stamp.toISOString(), modified: stamp.toISOString() })
    }
    const run = (label: string, query: Parameters<IndexService['library']>[0]) => {
      const start = performance.now()
      const result = index.library(query)
      const ms = performance.now() - start
      console.log(label + '：' + Math.round(ms) + ' 毫秒；总数 ' + result.total)
      expect(ms).toBeLessThan(1000)
      return result
    }
    expect(run('合并后分页', { offset: IDEAS }).total).toBe(IDEAS + FILES)
    expect(run('目录下文件', { scope: { selection: { kind: 'directory', path: 'content/工作', recursive: true } }, kind: 'file' }).total).toBe(FILES)
    expect(run('原文关键词', { kind: 'file', text: '指纹解锁' }).total).toBeGreaterThan(Math.floor(FILES / 30))
    expect(run('跨原文和摘要', { kind: 'file', text: '指纹解锁 摘要方案' }).total).toBeGreaterThan(Math.floor(FILES / 30))
  })
})
