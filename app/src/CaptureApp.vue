<script setup lang="ts">
import TextTools from '@/components/TextTools.vue'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { call, on } from '@/api'
import CaptureInput from '@/components/CaptureInput.vue'

// 快捷记录小窗。见 docs/user-guide.md。
const input = ref<InstanceType<typeof CaptureInput> | null>(null)
const box = ref<HTMLDivElement | null>(null)
let off: (() => void) | undefined

const hide = () => void call('capture:hideWindow')

async function resize(): Promise<void> {
  await nextTick()
  if (box.value) void call('capture:resize', { height: box.value.offsetHeight + 16 })
}

/** 失去焦点：没有内容就关闭，有内容就保留 */
function onBlur(): void {
  if (input.value?.isEmpty()) hide()
}

onMounted(async () => {
  const settings = await call('settings:get')
  const theme = settings.appearance.theme
  const dark = theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  off = on('capture:shown', () => {
    input.value?.focus()
    void resize()
  })
  window.addEventListener('blur', onBlur)
  input.value?.focus()
})
onUnmounted(() => {
  off?.()
  window.removeEventListener('blur', onBlur)
})
</script>

<template>
  <TextTools />
  <div ref="box" class="box" data-testid="capture-window">
    <CaptureInput ref="input" source="quick-capture" @saved="hide" @cancel="hide" @resize="resize" />
  </div>
</template>

<style>
html,
body {
  background: transparent !important;
}
</style>

<style scoped>
.box {
  margin: 8px;
  padding: 16px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.3);
}
</style>

