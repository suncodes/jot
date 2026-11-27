<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Plus, Trash2, Check } from 'lucide-vue-next'
import { call } from '@/api'
import { useAppStore } from '@/stores/app'
import { t } from '@/strings'
import AppSelect from '@/components/AppSelect.vue'
import AppDialog from '@/components/AppDialog.vue'
import ModelProfileEditor from '@/components/ModelProfileEditor.vue'
import { DEFAULT_MODEL_PROTOCOL, MODEL_PROTOCOLS } from '@shared/model-protocol'
import { modelOptions, type ModelCatalogInput, type ModelProfile } from '@shared/models'

const app = useAppStore()
const emptyModel = (): ModelProfile => ({ id: crypto.randomUUID(), name: '', model: '', reasoningEffort: 'auto' })
function snapshot(): ModelCatalogInput {
  return { channels: (app.settings?.models.channels ?? []).map(({ hasApiKey: _key, ...channel }) => JSON.parse(JSON.stringify(channel))), defaultModelId: app.settings?.models.defaultModelId ?? null }
}
const draft = ref<ModelCatalogInput>(snapshot())
const selectedChannel = ref(draft.value.channels[0]?.id ?? '')
const selectedModel = ref('')
const channel = computed(() => draft.value.channels.find(item => item.id === selectedChannel.value))
const profile = computed(() => channel.value?.models.find(item => item.id === selectedModel.value))
const savedChannel = computed(() => app.settings?.models.channels.find(item => item.id === channel.value?.id))
const protocolOptions = MODEL_PROTOCOLS.map(value => ({ value, label: t.onboarding.protocols[value] }))
const defaultOptions = computed(() => [{ value: '', label: '未设置全局默认' }, ...modelOptions({ ...draft.value, channels: draft.value.channels.map(item => ({ ...item, hasApiKey: false })) })])
const channelKeyInput = computed({ get: () => channel.value?.apiKey ?? '', set: value => { if (channel.value) channel.value.apiKey = value || undefined } })
const globalDefault = computed({ get: () => draft.value.defaultModelId ?? '', set: value => { draft.value.defaultModelId = value || null } })
const saving = ref(false), testing = ref(false), saved = ref(false), error = ref('')
const result = ref<{ ok: boolean; text: string } | null>(null)
const removing = ref<'channel' | 'model' | null>(null)
const baseline = ref(JSON.stringify(draft.value))
watch(selectedChannel, () => { selectedModel.value = channel.value?.models[0]?.id ?? ''; result.value = null }, { immediate: true })
watch(selectedModel, () => { result.value = null })
watch(draft, () => { result.value = null; saved.value = false }, { deep: true })
watch(() => app.settings?.models, () => {
  if (saving.value || JSON.stringify(draft.value) !== baseline.value) return
  draft.value = snapshot(); baseline.value = JSON.stringify(draft.value)
  if (!draft.value.channels.some(item => item.id === selectedChannel.value)) selectedChannel.value = draft.value.channels[0]?.id ?? ''
})
function addChannel(): void {
  const id = crypto.randomUUID(), model = emptyModel()
  draft.value.channels.push({ id, name: '新渠道', protocol: DEFAULT_MODEL_PROTOCOL, baseUrl: '', models: [model] })
  selectedChannel.value = id; selectedModel.value = model.id
}
function addModel(): void { const model = emptyModel(); channel.value?.models.push(model); selectedModel.value = model.id }
function connectionChanged(): void {
  for (const model of channel.value?.models ?? []) { delete model.contextWindow; model.reasoningEffort = 'auto' }
  result.value = null
}
function remove(): void {
  if (removing.value === 'channel' && channel.value) {
    const ids = new Set(channel.value.models.map(model => model.id))
    if (draft.value.defaultModelId && ids.has(draft.value.defaultModelId)) draft.value.defaultModelId = null
    draft.value.channels = draft.value.channels.filter(item => item.id !== selectedChannel.value)
    selectedChannel.value = draft.value.channels[0]?.id ?? ''
  } else if (channel.value && profile.value) {
    if (draft.value.defaultModelId === profile.value.id) draft.value.defaultModelId = null
    channel.value.models = channel.value.models.filter(item => item.id !== selectedModel.value)
    selectedModel.value = channel.value.models[0]?.id ?? ''
  }
  removing.value = null
}
async function test(): Promise<void> {
  if (!channel.value || !profile.value) return
  const tested = JSON.stringify([channel.value, profile.value.id])
  testing.value = true; result.value = null
  try {
    const config = { ...profile.value, protocol: channel.value.protocol, baseUrl: channel.value.baseUrl, modelId: app.settings?.models.channels.some(item => item.models.some(model => model.id === profile.value!.id)) ? profile.value.id : undefined, channelId: savedChannel.value?.id, apiKey: channel.value.apiKey, contextWindow: profile.value.contextWindow ?? null }
    const { id: _id, name: _name, ...input } = config
    const response = await call('settings:testModel', input)
    if (tested !== JSON.stringify([channel.value, profile.value?.id])) return
    result.value = { ok: response.ok, text: response.ok ? t.onboarding.testOk(response.latencyMs ?? 0) : response.message ?? '' }
  } catch (cause) { if (tested === JSON.stringify([channel.value, profile.value?.id])) result.value = { ok: false, text: (cause as Error).message } }
  finally { testing.value = false }
}
async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true; error.value = ''; saved.value = false
  try {
    await app.updateSettings({ models: JSON.parse(JSON.stringify(draft.value)) as ModelCatalogInput })
    draft.value = snapshot()
    await nextTick()
    baseline.value = JSON.stringify(draft.value); saved.value = true
  } catch (cause) { error.value = (cause as Error).message }
  finally { saving.value = false }
}
if (!draft.value.channels.length) addChannel()
</script>
<template>
  <div class="model-catalog" data-testid="model-catalog">
    <div class="catalog-default"><span>全局默认模型</span><AppSelect v-model="globalDefault" :options="defaultOptions" label="全局默认模型" searchable data-testid="model-global-default" /></div>
    <p class="small muted">新对话和后台任务使用全局默认模型；对话中可单独选择。</p>
    <div class="channel-layout">
      <nav class="channels" aria-label="模型渠道">
        <button v-for="item in draft.channels" :key="item.id" class="ghost channel-item" :class="{ selected: item.id === selectedChannel }" :data-channel-id="item.id" @click="selectedChannel = item.id"><span>{{ item.name }}</span><small>{{ item.models.length }} 个模型</small></button>
        <button class="ghost add-channel" data-testid="channel-add" @click="addChannel"><Plus :size="14" />添加渠道</button>
      </nav>
      <section v-if="channel" class="channel-editor">
        <header><strong>渠道连接</strong><button class="ghost icon-button" title="删除渠道" aria-label="删除渠道" data-testid="channel-delete" @click="removing = 'channel'"><Trash2 :size="14" /></button></header>
        <label><span>渠道名称</span><input v-model="channel.name" type="text" data-testid="channel-name" /></label>
        <div class="model-field"><span>接口协议</span><AppSelect v-model="channel.protocol" :options="protocolOptions" label="接口协议" data-testid="model-protocol" @update:model-value="connectionChanged" /></div>
        <label><span>基础地址</span><input v-model="channel.baseUrl" type="text" :placeholder="channel.protocol === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'" data-testid="model-base-url" @change="connectionChanged" /></label>
        <label><span>密钥</span><input v-model="channelKeyInput" type="password" :placeholder="savedChannel?.hasApiKey ? '已保存，留空保留；清除请点右侧' : '填写渠道 API Key'" data-testid="model-api-key" /><button v-if="savedChannel?.hasApiKey" class="ghost clear-key" @click="channel.apiKey = ''">清除</button></label>
        <div class="models-heading"><strong>模型</strong><button class="ghost" data-testid="model-add" @click="addModel"><Plus :size="14" />添加模型</button></div>
        <div class="model-list" role="list" aria-label="渠道模型">
          <button v-for="item in channel.models" :key="item.id" class="ghost model-item" :class="{ selected: item.id === selectedModel }" :data-model-id="item.id" @click="selectedModel = item.id"><span>{{ item.name || item.model || '新模型' }}</span><Check v-if="draft.defaultModelId === item.id" :size="12" aria-label="全局默认" /></button>
        </div>
        <template v-if="profile">
          <ModelProfileEditor :key="profile.id" :model-value="profile" :endpoint="{ protocol: channel.protocol, baseUrl: channel.baseUrl, model: profile.model }" @update:model-value="Object.assign(profile, $event)" />
          <div class="model-actions"><button data-testid="model-test" :disabled="testing || !profile.model || !channel.baseUrl" @click="test">{{ testing ? t.onboarding.testing : t.onboarding.test }}</button><button class="ghost" data-testid="model-set-default" @click="draft.defaultModelId = profile.id">{{ draft.defaultModelId === profile.id ? '当前全局默认' : '设为全局默认' }}</button><button class="ghost danger" data-testid="model-delete" @click="removing = 'model'">删除模型</button></div>
          <p v-if="channel.apiKey === ''" class="small muted">保存后清除此渠道密钥。</p>
          <p v-if="result" class="small selectable" :class="result.ok ? 'ok' : 'bad'" :data-ok="result.ok" role="status" data-testid="model-test-result">{{ result.text }}</p>
        </template>
        <p v-else class="small muted">添加模型后，可测试连接并设置为全局默认。</p>
      </section>
      <p v-else class="small muted">添加一个渠道，配置接口及可用模型。</p>
    </div>
    <footer class="catalog-save"><button class="primary" data-testid="model-save" :disabled="saving || testing" @click="save">保存配置</button><span v-if="saved" class="small muted">已保存</span><span v-if="error" class="small bad" role="alert" data-testid="model-save-error">{{ error }}</span></footer>
    <AppDialog v-if="removing" :title="removing === 'channel' ? '删除渠道' : '删除模型'" @close="removing = null"><p>从配置中移除{{ removing === 'channel' ? '该渠道及其模型' : '该模型' }}，保存后生效。已有对话记录保留，使用该模型的对话需重新选择。</p><template #footer><button class="ghost" @click="removing = null">取消</button><button class="danger" data-testid="model-remove-confirm" @click="remove">确认移除</button></template></AppDialog>
  </div>
</template>
<style scoped>
.model-catalog { display:grid; gap:var(--space-3); min-width:0; }
.catalog-default { display:grid; grid-template-columns:104px minmax(0, 1fr); gap:var(--space-3); align-items:center; font-size:var(--font-size-small); }
.channel-layout { display:grid; grid-template-columns:150px minmax(0, 1fr); border-top:1px solid var(--border); padding-top:var(--space-4); gap:var(--space-5); }
.channels { display:flex; flex-direction:column; gap:var(--space-1); min-width:0; }
.channel-item { display:grid; text-align:left; min-width:0; padding:var(--space-2) var(--space-3); }
.channel-item span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.channel-item small { color:var(--text-faint); font-size:11px; }
.selected { background:var(--accent-soft); color:var(--accent); }
.add-channel, .models-heading button { display:flex; gap:var(--space-1); align-items:center; font-size:var(--font-size-small); }
.channel-editor { display:grid; gap:var(--space-3); min-width:0; }
header, .models-heading { display:flex; justify-content:space-between; align-items:center; }
header strong, .models-heading strong { font-size:var(--font-size-small); font-weight:600; }
label, .model-field { display:grid; grid-template-columns:88px minmax(0, 1fr); align-items:center; gap:var(--space-3); position:relative; font-size:var(--font-size-small); }
input { min-width:0; width:100%; }
.clear-key { position:absolute; right:4px; font-size:11px; }
label:has(.clear-key) input { padding-right:40px; }
.models-heading { margin-top:var(--space-2); border-top:1px solid var(--border); padding-top:var(--space-3); }
.model-list { display:flex; flex-wrap:wrap; gap:var(--space-1); }
.model-item { display:flex; align-items:center; gap:var(--space-1); max-width:100%; font-size:var(--font-size-small); }
.model-item span { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.model-actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-2); font-size:var(--font-size-small); }
.model-actions button { font-size:inherit; }
.danger { color:var(--danger); }
.catalog-save { display:flex; align-items:center; gap:var(--space-3); border-top:1px solid var(--border); padding-top:var(--space-4); }
p { margin:0; }
.ok { color:var(--success); } .bad { color:var(--danger); }
@media (max-width:640px) { .channel-layout { grid-template-columns:minmax(0, 1fr); gap:var(--space-3); } .channels { flex-direction:row; flex-wrap:wrap; } .channel-item { max-width:170px; } }
</style>
