import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AgentConfiguration, CapabilityCatalog, PluginChange, SkillChange } from '@shared/capabilities'
import type { RunRecord } from '@shared/assistant'
import { call, on } from '@/api'
import { useAppStore } from './app'
import { t } from '@/strings'
import { dependencyProblems, type CapabilityPage } from '@/capabilities/model'

export const useCapabilitiesStore = defineStore('capabilities', () => {
  const app = useAppStore()
  const catalog = ref<CapabilityCatalog | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const agents = computed(() => catalog.value?.agents ?? [])
  const skills = computed(() => catalog.value?.skills ?? [])
  const runs = ref<RunRecord[]>([])
  const runTotal = ref(0)
  const page = ref<CapabilityPage>('agents')
  const requestedDetail = ref(0)
  const detailRequested = ref(false)
  const selected = ref('')
  const selections = new Map<CapabilityPage, string>()
  const conversationRequest = ref<{ id: string; tick: number } | null>(null)
  let sequence = 0
  let runSequence = 0
  let runQuery: { text?: string; status?: RunRecord['status']; offset?: number; limit?: number } = { limit: 30 }
  let pending: Promise<void> | null = null

  async function loadRuns(query?: typeof runQuery): Promise<void> {
    if (query) runQuery = query
    const mine = ++runSequence
    const data = await call('capabilities:runs', runQuery)
    if (mine !== runSequence) return
    runs.value = data.items
    runTotal.value = data.total
  }
  async function fetchCatalog(): Promise<void> {
    const mine = ++sequence
    loading.value = true
    error.value = ''
    try {
      const data = await call('capabilities:catalog')
      if (mine !== sequence) return
      catalog.value = data
      await loadRuns()
    } catch (e) { if (mine === sequence) error.value = (e as Error).message }
    finally { if (mine === sequence) { loading.value = false; pending = null } }
  }
  function load(force = false): Promise<void> {
    if (saving.value || (catalog.value && !force)) return Promise.resolve()
    pending ??= fetchCatalog()
    return pending
  }
  async function save(operation: () => Promise<CapabilityCatalog>): Promise<boolean> {
    if (saving.value) return false
    saving.value = true
    error.value = ''
    const vaultPath = app.vault.path
    try {
      await pending
      if (app.vault.path !== vaultPath) return false
      const data = await operation()
      if (app.vault.path !== vaultPath) return false
      catalog.value = data
      return true
    } catch (e) {
      if (app.vault.path === vaultPath) error.value = (e as Error).message
      return false
    } finally { saving.value = false }
  }
  function saveAgent(agent: AgentConfiguration): Promise<boolean> {
    const { id, name, description, instructions, skillIds, toolIds, enabled } = agent
    if (id === 'default') return save(() => call('capabilities:changeAgent', { action: 'configure-default', instructions }))
    return save(() => call('capabilities:changeAgent', {
      action: 'save', agent: { id, name, description, instructions, skillIds: [...skillIds], toolIds: [...toolIds], enabled },
    }))
  }
  function changeAgent(action: 'remove', id: string): Promise<boolean> {
    return save(() => call('capabilities:changeAgent', { action, id }))
  }
  function changeSkill(change: SkillChange): Promise<boolean> {
    return save(() => call('capabilities:changeSkill', change))
  }
  function setPluginEnabled(id: string, enabled: boolean): Promise<boolean> {
    return save(() => call('capabilities:setPluginEnabled', { id, enabled }))
  }
  function importPlugin(token: string): Promise<boolean> {
    return save(() => call('capabilities:confirmPluginImport', { token }))
  }
  function importSkill(token: string, name: string): Promise<boolean> {
    return save(() => call('capabilities:confirmSkillImport', { token, name }))
  }
  function changePlugin(change: PluginChange): Promise<boolean> { return save(() => call('capabilities:changePlugin', change)) }
  function setToolEnabled(id: string, enabled: boolean): Promise<boolean> { return save(() => call('capabilities:setToolEnabled', { id, enabled })) }
  function setAgentEnabled(id: string, enabled: boolean): Promise<boolean> { return save(() => call('capabilities:setAgentEnabled', { id, enabled })) }
  function setTaskSkills(patch: Partial<import('@shared/ai-tasks').TaskSkillBindings>): Promise<boolean> { return save(() => call('capabilities:setTaskSkills', patch)) }
  function patchResources(owner: import('@shared/capabilities').CapabilityOwner, id: string, files: import('@shared/capabilities').CapabilityFileInput[]): Promise<boolean> {
    return save(() => call('capabilities:patchResources', { owner, id, files }))
  }
  on('capabilities:changed', () => { if (!saving.value) void load(true) })

  function problems(agentId: string, skillId?: string | null): string[] {
    const agent = agents.value.find(item => item.id === agentId)
    const tools = agent?.toolIds.filter(id => !catalog.value?.tools.some(tool => tool.id === id && tool.enabled)) ?? []
    return [...(tools.length ? [t.capabilities.missingTools(agent?.name ?? '', tools.join('、'))] : []), ...dependencyProblems(agent, skills.value, skillId).map(problem => {
      if (problem.kind === 'agent') return t.capabilities.invalidAgent
      if (problem.kind === 'skill') return t.capabilities.unavailableSkill(problem.skill!)
      return t.capabilities.missingTools(problem.skill!, problem.tools!.join('、'))
    })]
  }
  function open(kind: CapabilityPage, id = ''): void {
    if (kind !== page.value) {
      selections.set(page.value, selected.value)
      page.value = kind
      selected.value = selections.get(kind) ?? ''
    }
    if (id) selected.value = id
    detailRequested.value = !!id
    requestedDetail.value++
  }
  function openConversation(id: string): void { conversationRequest.value = { id, tick: Date.now() } }
  watch(() => app.vault.path, () => {
    sequence++; runSequence++; runQuery = { limit: 30 }; runTotal.value = 0; pending = null; catalog.value = null; loading.value = false
    runs.value = []; error.value = ''
    selections.clear(); page.value = 'agents'; selected.value = ''; conversationRequest.value = null
  })
  return { catalog, loading, saving, error, agents, skills, runs, runTotal, page, selected, requestedDetail, detailRequested, conversationRequest, load, loadRuns, saveAgent, changeAgent, changeSkill, changePlugin, setToolEnabled, setAgentEnabled, setTaskSkills, patchResources, importSkill, setPluginEnabled, importPlugin, problems, open, openConversation }
})
