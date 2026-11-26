<script setup lang="ts">
import TextTools from '@/components/TextTools.vue'
import { onMounted, ref } from 'vue'
import { useAppStore } from '@/stores/app'
import Onboarding from '@/views/Onboarding.vue'
import Shell from '@/components/Shell.vue'

const app = useAppStore()
const failed = ref('')
/** 库已经打开时不再显示引导；引导走完后进入主界面 */
const onboarded = ref(false)

onMounted(async () => {
  try {
    await app.init()
    onboarded.value = app.vault.open
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e)
  }
})
</script>

<template>
  <TextTools />
  <div v-if="failed" class="boot-error selectable" data-testid="boot-error">{{ failed }}</div>
  <template v-else-if="app.ready">
    <Shell v-if="onboarded" />
    <Onboarding v-else @done="onboarded = true" />
  </template>
</template>

<style scoped>
.boot-error {
  padding: var(--space-4);
  color: var(--danger);
}
</style>

