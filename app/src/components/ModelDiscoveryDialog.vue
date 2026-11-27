<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RefreshCw, Search } from 'lucide-vue-next'
import { call } from '@/api'
import AppDialog from '@/components/AppDialog.vue'
import type { DiscoveredModel, ModelDiscoveryInput } from '@shared/model-discovery'
import type { ModelProfile } from '@shared/models'

const { connection, existing } = defineProps<{ connection: ModelDiscoveryInput; existing: ModelProfile[] }>()
const emit = defineEmits<{ close: []; add: [models: DiscoveredModel[]] }>()
const loading = ref(false), error = ref(''), query = ref(''), truncated = ref(false)
const candidates = ref<DiscoveredModel[]>([]), selected = ref<string[]>([])
const visibleCount = ref(100)
let active = true
const present = computed(() => new Set(existing.map(model => model.model)))
const filtered = computed(() => {
  const text = query.value.trim().toLocaleLowerCase()
  return candidates.value.filter(model => (model.id + ' ' + model.name).toLocaleLowerCase().includes(text))
})
const visible = computed(() => filtered.value.slice(0, query.value ? 200 : visibleCount.value))
const capacity = computed(() => Math.max(0, 100 - existing.filter(model => model.model || model.name).length))
const chosen = computed(() => candidates.value.filter(model => selected.value.includes(model.id) && !present.value.has(model.id)))
async function refresh(): Promise<void> {
  if (loading.value) return
  loading.value = true; error.value = ''
  try {
    const result = await call('settings:discoverModels', connection)
    if (!active) return
    candidates.value = result.models; truncated.value = result.truncated
    selected.value = selected.value.filter(id => result.models.some(model => model.id === id) && !present.value.has(id))
  } catch (cause) { if (active) { candidates.value = []; selected.value = []; error.value = (cause as Error).message } }
  finally { if (active) loading.value = false }
}
function choose(model: DiscoveredModel, checked: boolean): void {
  if (present.value.has(model.id) || checked && chosen.value.length >= capacity.value) return
  if (checked) selected.value = [...selected.value, model.id]
  else selected.value = selected.value.filter(id => id !== model.id)
}
function selectVisible(): void {
  const ids = new Set(selected.value)
  for (const model of visible.value) {
    if (ids.size >= capacity.value) break
    if (!present.value.has(model.id)) ids.add(model.id)
  }
  selected.value = [...ids]
}
onMounted(() => { void refresh() })
onBeforeUnmount(() => { active = false })
</script>
<template>
  <AppDialog title="获取模型" class="discover-dialog" scroll-body @close="emit('close')">
    <div class="model-discovery" data-testid="model-discovery">
      <p class="muted small">从当前渠道获取候选，选中后添加到配置草稿。是否支持当前协议、工具及推理档位，请添加后测试连接。</p>
      <div class="discovery-tools"><label class="discovery-search"><Search :size="14" /><input v-model="query" type="search" placeholder="搜索模型名称或标识" aria-label="搜索模型" data-testid="model-discovery-search" /></label><button class="ghost icon-button" title="刷新模型列表" aria-label="刷新模型列表" :disabled="loading" data-testid="model-discovery-refresh" @click="refresh"><RefreshCw :size="14" /></button></div>
      <p v-if="loading" class="muted small" role="status" data-testid="model-discovery-loading">正在获取模型…</p>
      <p v-else-if="error" class="bad small selectable" role="alert" data-testid="model-discovery-error">{{ error }}<span> 可关闭此窗口后手动添加。</span></p>
      <template v-else>
        <div class="discovery-selection"><span class="small muted">{{ candidates.length }} 个候选 · 已选 {{ chosen.length }}</span><button class="ghost" :disabled="!visible.length || chosen.length >= capacity" data-testid="model-discovery-select-visible" @click="selectVisible">选择当前显示</button></div>
        <p v-if="truncated" class="small muted" role="status">服务返回的候选过多，本次只展示已取回的部分；仍可手动添加其他模型。</p>
        <div class="discovery-list">
          <label v-for="model in visible" :key="model.id" class="discovery-item" :class="{ added: present.has(model.id) }" :data-discovered-model="model.id">
            <input type="checkbox" :checked="present.has(model.id) || selected.includes(model.id)" :disabled="present.has(model.id) || !selected.includes(model.id) && chosen.length >= capacity" :aria-label="model.id" @change="choose(model, ($event.target as HTMLInputElement).checked)" /><span><strong>{{ model.name }}</strong><small v-if="model.name !== model.id">{{ model.id }}</small></span><small v-if="present.has(model.id)" class="muted">已添加</small>
          </label>
          <p v-if="!visible.length" class="small muted discovery-empty">{{ query ? '没有匹配的模型' : '服务未返回可选模型，可手动添加。' }}</p>
        </div>
        <button v-if="!query && visible.length < filtered.length" class="ghost" data-testid="model-discovery-more" @click="visibleCount += 100">显示更多（还有 {{ filtered.length - visible.length }} 个）</button>
        <p v-if="query && filtered.length > visible.length" class="small muted">匹配结果较多，请继续缩小搜索范围。</p>
        <p v-if="capacity <= chosen.length" class="small muted">每个渠道最多配置 100 个模型。</p>
      </template>
    </div>
    <template #footer><div class="dialog-actions"><button class="ghost" @click="emit('close')">取消</button><button class="primary" :disabled="loading || !chosen.length || chosen.length > capacity" data-testid="model-discovery-add" @click="emit('add', chosen)">添加选中（{{ chosen.length }}）</button></div></template>
  </AppDialog>
</template>
<style scoped>
.model-discovery { display:grid; gap:var(--space-3); min-width:0; }
p { margin:0; }
.discovery-tools, .discovery-selection { display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); min-width:0; }
.model-discovery .discovery-search { display:flex; align-items:center; gap:var(--space-2); flex:1; min-width:0; color:var(--text-muted); border:1px solid var(--border); padding:var(--space-1) var(--space-2); border-radius:var(--radius-s); }
.model-discovery .discovery-search:focus-within { border-color:var(--accent); }
.discovery-search input { width:100%; min-width:0; padding:0; border:0; outline:0; background:transparent; font-size:var(--font-size-small); }
.discovery-selection button { font-size:var(--font-size-small); }
.discovery-list { max-height:360px; overflow:auto; border:1px solid var(--border); border-radius:var(--radius-s); }
.model-discovery .discovery-item { display:flex; align-items:center; gap:var(--space-3); padding:var(--space-2) var(--space-3); cursor:pointer; }
.discovery-item + .discovery-item { border-top:1px solid var(--border); }
.discovery-item > span { flex:1; min-width:0; }
.discovery-item strong { display:block; font-size:var(--font-size-small); font-weight:500; overflow-wrap:anywhere; }
.discovery-item small { display:block; color:var(--text-muted); font-size:11px; overflow-wrap:anywhere; }
.discovery-item.added { color:var(--text-muted); background:var(--bg-secondary); }
.discovery-item input { accent-color:var(--accent); }
.discovery-empty { padding:var(--space-4); text-align:center; }
.bad { color:var(--danger); }
</style>
