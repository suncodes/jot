import path from 'node:path'
import { test } from '@playwright/test'
import { cleanup, launch, shot } from './helpers'
import { startFakeLlm } from '../helpers/fake-llm'
import { installAndReport, resumeAndManage, removeWorkReportIndex, W5_NOW, W5_RESTART } from './work-report-flow'

test('W5组合：真实联装配置、跨年四类报告、删索引重启后回读与覆盖、独立启停卸载', async () => {
  test.setTimeout(150000)
  const fake = await startFakeLlm()
  let launched = await launch({ isolateHotkey: true, now: W5_NOW })
  const vault = path.join(launched.workDir, 'W5虚构组合库')
  try {
    const state = await installAndReport(launched.page, vault, fake)
    await shot(launched.page, 'w5-combination-light')
    await launched.close()
    removeWorkReportIndex(vault)
    launched = await launch({ isolateHotkey: true, now: W5_RESTART, reuse: launched })
    await resumeAndManage(launched.page, vault, fake, state)
    await shot(launched.page, 'w5-combination-restart-dark')
  } finally { await launched.close(); await fake.close(); cleanup(launched.userData, launched.workDir) }
})
