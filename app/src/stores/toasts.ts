import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Toast {
  id: number
  kind: 'info' | 'error'
  text: string
  action?: { label: string; run: () => void | Promise<void> }
}

/** 状态栏上方的提示，不覆盖正文或输入操作。成功的提示 2 秒后消失（带操作的留 6 秒）；错误提示保留到手动关闭。 */
export const useToastsStore = defineStore('toasts', () => {
  const items = ref<Toast[]>([])
  let seq = 0

  function dismiss(id: number): void {
    items.value = items.value.filter((t) => t.id !== id)
  }
  function info(text: string, action?: Toast['action']): void {
    const id = ++seq
    items.value.push({ id, kind: 'info', text, action })
    setTimeout(() => dismiss(id), action ? 6000 : 2000)
  }
  function error(text: string, action?: Toast['action']): void {
    items.value.push({ id: ++seq, kind: 'error', text, action })
  }
  return { items, info, error, dismiss }
})
