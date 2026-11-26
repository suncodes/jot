import { describe, expect, it } from 'vitest'
import { calendarDate, expandDatePath, pathDay } from '@shared/date-paths'
import { createWorkReportOptions, previewWorkReport, previewWorkReportMonth, workReportPeriod, type WorkReportOptions } from '@shared/work-reports'
import { workReportOptions, workReportRequest } from '../../electron/extensions/schema'

const options = (patch: Partial<WorkReportOptions> = {}): WorkReportOptions => ({
  ...createWorkReportOptions(), root: 'content/事务/工作记录', ...patch,
})
const today = new Date(2026, 10, 24, 23, 59)

describe('工作报告共享配置', () => {
  it('根目录等待用户配置，不用预设工作目录替代；未配置不能计算写入目标', () => {
    const pending = createWorkReportOptions()
    expect(workReportOptions.parse(pending).root).toBeNull()
    expect(() => previewWorkReportMonth(pending, today)).toThrow('请选择工作根目录')
    expect(() => previewWorkReport(pending, { kind: 'daily' }, today)).toThrow('请选择工作根目录')
  })

  it('保存完整可读选项，工程日志可在其他 content 目录，模板沿用现有三种来源', () => {
    const configured = options({
      worklogDirectory: 'content/开发资料/工程日志',
      template: { kind: 'package', path: 'templates/日报草稿.md' },
      okrTemplate: { kind: 'user', path: 'templates/工作/OKR.md' },
    })
    expect(workReportOptions.parse(JSON.parse(JSON.stringify(configured)))).toEqual(configured)
    expect(workReportOptions.parse(options({ okrTemplate: { kind: 'none' } })).okrTemplate).toEqual({ kind: 'none' })
    expect(workReportOptions.parse(options()).okrTemplate).toBeNull()
  })

  it.each([
    { root: 'D:/个人资料' }, { root: '../content/工作' }, { root: 'content/../工作' },
    { root: 'content/CON' }, { root: 'content/工作/{{yyyy}}' }, { root: 'inbox/工作' },
    { draftDirectory: '/草稿/{{yyyy}}/{{MM}}' }, { draftDirectory: '../草稿/{{yyyy}}/{{MM}}' },
    { draftDirectory: '草稿/{{MM}}' }, { draftDirectory: '草稿/{{yyyy}}/{{MM}}/{{dd}}' },
    { reportDirectory: '总结/{{yyyy}}/{{MM}}/{{unknown}}' }, { reportDirectory: '总结/{{yyyy}}/{{MM}}/尾空格 ' },
    { reportDirectory: '草稿/{{yyyy}}年{{MM}}月' }, { reportDirectory: '草稿/{{yyyy}}年{{MM}}月/总结' },
    { draftDirectory: 'DRAFT/{{yyyy}}/{{MM}}', reportDirectory: 'draft/{{yyyy}}/{{MM}}' },
    { worklogDirectory: 'templates/工程日志' }, { worklogDirectory: 'content/日志/{{yyyy}}' },
    { filename: '今日日报.md' }, { filename: '../{{dd}}.md' }, { filename: '{{dd}} {{title}}.md' },
    { template: { kind: 'package', path: '../模板.md' } },
    { okrTemplate: { kind: 'user', path: 'content/模板.md' } },
  ] satisfies Partial<WorkReportOptions>[])('拒绝越界、失效月份规则或有覆盖风险的配置 %j', patch => {
    expect(workReportOptions.safeParse(options(patch)).success).toBe(false)
  })

  it('请求只接受四类报告和真实锚点日期，不接受任意输出路径或跳过确认参数', () => {
    expect(workReportRequest.parse({ kind: 'daily' })).toEqual({ kind: 'daily' })
    expect(workReportRequest.parse({ kind: 'monthly', date: '2028-02-29' })).toEqual({ kind: 'monthly', date: '2028-02-29' })
    for (const invalid of [{ kind: 'yearly' }, { kind: 'daily', date: '2026-02-30' }, { kind: 'daily', path: 'content/其他文件.md' }, { kind: 'daily', overwrite: true }]) {
      expect(workReportRequest.safeParse(invalid).success).toBe(false)
    }
  })

  it('必需字段和未知字段严格校验，不填补旧配置、不接受脚本入口', () => {
    const { reportDirectory: _reportDirectory, ...incomplete } = options()
    for (const invalid of [incomplete, { ...options(), script: 'init.py' }, { ...options(), overwrite: true }]) {
      expect(workReportOptions.safeParse(invalid).success).toBe(false)
    }
  })
})

describe('工作月份路径预览', () => {
  it('仅计算一个草稿月目录检查入口、八个分类目录和当天草稿，OKR 只给目标路径', () => {
    const preview = previewWorkReportMonth(options(), today)
    const root = 'content/事务/工作记录'
    expect(preview).toMatchObject({
      date: '2026-11-24', month: '2026-11',
      draftDirectory: root + '/草稿/2026年11月',
      reportDirectory: root + '/AI总结/2026年11月',
      draftOkrPath: root + '/草稿/2026年11月/1、OKR/2026年11月OKR.md',
      dailyDraft: { date: '2026-11-24', path: root + '/草稿/2026年11月/2、日报/2026-11-24.md' },
    })
    expect(preview.directories).toEqual([
      root + '/草稿/2026年11月/1、OKR', root + '/草稿/2026年11月/2、日报',
      root + '/草稿/2026年11月/3、周报', root + '/草稿/2026年11月/4、月报',
      root + '/AI总结/2026年11月/1、OKR', root + '/AI总结/2026年11月/2、日报',
      root + '/AI总结/2026年11月/3、周报', root + '/AI总结/2026年11月/4、月报',
    ])
    expect(preview.directories.every(path => !path.endsWith('.md'))).toBe(true)
  })

  it('日期占位符允许自由目录层级，草稿文件只需含日，根目录可自选', () => {
    const configured = options({ root: 'content/自选资料', draftDirectory: '原始记录/{{yyyy}}年/{{MM}}月/草稿', reportDirectory: '成稿/{{yyyy}}-{{MM}}', filename: '{{dd}} 工作记录' })
    expect(workReportOptions.safeParse(configured).success).toBe(true)
    const preview = previewWorkReportMonth(configured, today)
    expect(preview.draftDirectory).toBe('content/自选资料/原始记录/2026年/11月/草稿')
    expect(preview.dailyDraft.path).toBe('content/自选资料/原始记录/2026年/11月/草稿/2、日报/24 工作记录.md')
    expect(preview.reportDirectory).toBe('content/自选资料/成稿/2026-11')
  })

  it('跨月跨年及闰日保持目录、当天草稿和 OKR 的同一个本地日期', () => {
    for (const date of [new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1), new Date(2028, 1, 29)]) {
      const preview = previewWorkReportMonth(options(), date)
      const day = pathDay(date), monthName = day.slice(0, 4) + '年' + day.slice(5, 7) + '月'
      expect(preview.draftDirectory).toBe('content/事务/工作记录/草稿/' + monthName)
      expect(preview.dailyDraft.path).toContain('/' + day + '.md')
      expect(preview.draftOkrPath.endsWith('/' + monthName + 'OKR.md')).toBe(true)
    }
  })
})

describe('报告日期范围和正式输出路径', () => {
  it.each([
    ['daily', '2026-11-24', '2026-11-24', '2、日报/2026-11-24.md'],
    ['weekly', '2026-11-23', '2026-11-24', '3、周报/2026-11-23~2026-11-24.md'],
    ['monthly', '2026-11-01', '2026-11-24', '4、月报/2026-11月报.md'],
    ['okr', '2026-11-01', '2026-11-24', '1、OKR/2026年11月OKR.md'],
  ] as const)('默认 %s 使用实际统计范围并保存到正式报告目录', (kind, from, to, target) => {
    expect(previewWorkReport(options(), { kind }, today)).toEqual({
      kind, date: '2026-11-24', from, to, path: 'content/事务/工作记录/AI总结/2026年11月/' + target,
    })
  })

  it('正式日报用标准日期命名，草稿文件名可按用户习惯装饰', () => {
    const configured = options({ filename: '{{dd}} 工作日记.md' })
    expect(previewWorkReportMonth(configured, today).dailyDraft.filename).toBe('24 工作日记.md')
    expect(previewWorkReport(configured, { kind: 'daily' }, today).path).toBe('content/事务/工作记录/AI总结/2026年11月/2、日报/2026-11-24.md')
  })

  it('历史工作周取完整周一至周五，周末生成也以周五结束', () => {
    expect(workReportPeriod({ kind: 'weekly', date: '2026-11-18' }, today)).toMatchObject({ from: '2026-11-16', to: '2026-11-20' })
    expect(workReportPeriod({ kind: 'weekly' }, new Date(2026, 10, 29))).toMatchObject({ from: '2026-11-23', to: '2026-11-27' })
  })

  it('跨月工作周按实际结束日归月，同周不同锚点不创建不同月份的同范围报告', () => {
    const first = previewWorkReport(options(), { kind: 'weekly', date: '2026-08-31' }, today)
    const second = previewWorkReport(options(), { kind: 'weekly', date: '2026-09-04' }, today)
    expect(first.path).toBe('content/事务/工作记录/AI总结/2026年09月/3、周报/2026-08-31~2026-09-04.md')
    expect(second.path).toBe(first.path)
  })

  it('跨年工作周和当前月中生成，文件名明确表示实际覆盖范围', () => {
    const now = new Date(2026, 11, 31)
    expect(previewWorkReport(options(), { kind: 'weekly' }, now)).toMatchObject({
      from: '2026-12-28', to: '2026-12-31', path: 'content/事务/工作记录/AI总结/2026年12月/3、周报/2026-12-28~2026-12-31.md',
    })
    expect(previewWorkReport(options(), { kind: 'weekly', date: '2026-12-28' }, new Date(2027, 0, 3))).toMatchObject({
      from: '2026-12-28', to: '2027-01-01', path: 'content/事务/工作记录/AI总结/2027年01月/3、周报/2026-12-28~2027-01-01.md',
    })
  })

  it('历史月报取完整月份，闰年二月和普通二月正确计算', () => {
    expect(workReportPeriod({ kind: 'monthly', date: '2028-02-10' }, new Date(2028, 3, 1))).toMatchObject({ from: '2028-02-01', to: '2028-02-29' })
    expect(workReportPeriod({ kind: 'monthly', date: '2027-02-10' }, new Date(2028, 3, 1))).toMatchObject({ from: '2027-02-01', to: '2027-02-28' })
    expect(workReportPeriod({ kind: 'okr', date: '2026-10-15' }, today)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' })
  })

  it.each(['daily', 'weekly', 'monthly', 'okr'] as const)('拒绝尚未开始的 %s 周期，不把未来材料混入当前报告', kind => {
    expect(() => workReportPeriod({ kind, date: '2027-01-01' }, today)).toThrow('尚未开始')
  })

  it.each(['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-01', '0000-01-01', '2026-11-24T00:00:00Z'])('拒绝无效报告日期 %s', date => {
    expect(() => previewWorkReport(options(), { kind: 'daily', date }, today)).toThrow('日期无效')
  })
})

describe('共用日期路径基础', () => {
  it('月路径只展开日期，真实闰日合法，拒绝自动修正、未知变量和越界', () => {
    expect(expandDatePath('草稿/{{yyyy}}年{{MM}}月', '2028-02-29')).toBe('草稿/2028年02月')
    expect(calendarDate('2028-02-29').getUTCDate()).toBe(29)
    for (const [pattern, day] of [['草稿/{{yyyy}}', '2026-02-30'], ['草稿/{{date}}', '2026-11-24'], ['../草稿/{{MM}}', '2026-11-24']]) {
      expect(() => expandDatePath(pattern!, day!)).toThrow()
    }
  })
})
