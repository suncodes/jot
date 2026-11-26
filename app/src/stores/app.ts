import type { SettingsSection } from '@/settings/sections'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppInfo, JobsSummary, ModelState, Settings, SettingsInput, VaultStatus } from '@shared/types'
import { call, on } from '@/api'

/** 应用级状态：库、设置、模型状态、布局 */
export const useAppStore = defineStore('app', () => {
  const ready = ref(false)
  const info = ref<AppInfo | null>(null)
  const vault = ref<VaultStatus>({ open: false })
  const settings = ref<Settings | null>(null)
  const modelState = ref<ModelState>('not-configured')
  /** 要在助手面板里打开的对话（从时间线上点了一次 AI 对话） */
  const openConversation = ref<string | null>(null)
  const showSettings = ref(false)
  const settingsSection = ref<SettingsSection>('vault')
  /** 后台任务抽屉是否打开 */
  const showJobs = ref(false)
  const inboxCount = ref(0)
  const jobs = ref<JobsSummary>({ running: 0, queued: 0, failed: 0, waitingModel: 0 })

  function applyTheme(theme: Settings['appearance']['theme']): void {
    const dark = theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark'
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }

  async function refreshStatus(): Promise<void> {
    const st = await call('app:status')
    inboxCount.value = st.inboxCount
    jobs.value = st.jobs
    modelState.value = st.modelState
  }

  async function init(): Promise<void> {
    const [i, v, s] = await Promise.all([call('app:info'), call('vault:status'), call('settings:get')])
    info.value = i
    vault.value = v
    settings.value = s
    await refreshStatus()
    applyTheme(s.appearance.theme)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (settings.value) applyTheme(settings.value.appearance.theme)
    })
    on('settings:changed', (next) => { settings.value = next; applyTheme(next.appearance.theme) })
    on('model:status', (e) => {
      modelState.value = e.state
    })
    on('inbox:count', (e) => {
      inboxCount.value = e.count
    })
    on('jobs:updated', ({ running, queued, failed, waitingModel }) => {
      jobs.value = { running, queued, failed, waitingModel }
    })
    ready.value = true
  }

  async function openVault(path: string, create: boolean): Promise<void> {
    const opened = await call('vault:open', { path, create })
    vault.value = { open: true, path: opened.path }
    settings.value = await call('settings:get')
    await refreshStatus()
  }

  async function updateSettings(input: SettingsInput): Promise<void> {
    const next = await call('settings:set', input)
    settings.value = next
    applyTheme(next.appearance.theme)
  }

  return { ready, info, vault, settings, modelState, showSettings, settingsSection, showJobs, openConversation, inboxCount, jobs, init, openVault, updateSettings }
})
