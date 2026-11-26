<script setup lang="ts">
import { computed, ref } from 'vue'
import { ApiError, call } from '@/api'
import CaptureInput from '@/components/CaptureInput.vue'
import ModelForm from '@/components/ModelForm.vue'
import { useAppStore } from '@/stores/app'
import { t } from '@/strings'

const emit = defineEmits<{ done: [] }>()
const app = useAppStore()

const step = ref<1 | 2 | 3>(app.vault.open ? 2 : 1)
const vaultPath = ref('')
const busy = ref(false)
const error = ref('')
const tried = ref(false)

const hotkey = computed(() => app.settings?.capture.hotkey ?? 'Ctrl+Alt+N')
const modelReady = computed(() => !!app.settings?.model.baseUrl && !!app.settings.model.model)

async function pick(): Promise<void> {
  const r = await call('vault:pick')
  if (r) vaultPath.value = r.path
}

async function useVault(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    await app.openVault(vaultPath.value.trim(), true)
    step.value = 2
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="onboarding" data-testid="onboarding">
    <div class="card">
      <h1>{{ t.onboarding.title }}</h1>
      <div class="steps small muted">
        <span :class="{ on: step === 1 }">1 {{ t.onboarding.stepVault }}</span>
        <span :class="{ on: step === 2 }">2 {{ t.onboarding.stepModel }}</span>
        <span :class="{ on: step === 3 }">3 {{ t.onboarding.stepDone }}</span>
      </div>

      <section v-if="step === 1">
        <p class="muted">{{ t.onboarding.vaultHint }}</p>
        <div class="row">
          <input
            v-model="vaultPath"
            type="text"
            data-testid="vault-path"
            :placeholder="t.onboarding.vaultPlaceholder"
            @keydown.enter="vaultPath.trim() && useVault()"
          />
          <button data-testid="vault-pick" @click="pick">{{ t.onboarding.pick }}</button>
        </div>
        <p v-if="error" class="error small selectable" data-testid="onboarding-error">{{ error }}</p>
        <div class="actions">
          <button class="primary" data-testid="vault-use" :disabled="!vaultPath.trim() || busy" @click="useVault">
            {{ t.onboarding.createVault }}
          </button>
        </div>
      </section>

      <section v-else-if="step === 2">
        <p class="muted">{{ t.onboarding.modelHint }}</p>
        <p v-if="modelReady && app.info?.dev" class="small muted" data-testid="dev-model">{{ t.onboarding.devModelDetected }}</p>
        <ModelForm />
        <div class="actions">
          <button class="ghost" data-testid="model-skip" @click="step = 3">{{ t.onboarding.skip }}</button>
          <button class="primary" data-testid="model-next" @click="step = 3">{{ t.onboarding.next }}</button>
        </div>
      </section>

      <section v-else>
        <p>{{ t.onboarding.doneHint(hotkey) }}</p>
        <p class="muted small">{{ tried ? t.onboarding.tried : t.onboarding.tryHint }}</p>
        <div v-if="!tried" class="try" data-testid="onboarding-try">
          <CaptureInput source="main-window" @saved="tried = true" />
        </div>
        <div class="actions">
          <button class="primary" data-testid="onboarding-start" @click="emit('done')">{{ t.onboarding.start }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.onboarding {
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--bg-secondary);
}
.card {
  width: 560px;
  padding: 32px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow);
}
h1 {
  margin: 0 0 var(--space-3);
  font-size: 22px;
  font-weight: 600;
}
.steps {
  display: flex;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}
.steps .on {
  color: var(--accent);
}
.row {
  display: flex;
  gap: var(--space-2);
}
.row input {
  flex: 1;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.error {
  color: var(--danger);
}
.try {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
}
</style>
