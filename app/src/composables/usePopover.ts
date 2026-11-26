import { nextTick, readonly, ref, watch, type CSSProperties } from 'vue'

// 共享弹层定位与关闭行为。传送到 body，避免被面板的 overflow 裁剪。
export function usePopover(width?: number) {
  const anchor = ref<HTMLElement | null>(null)
  const panel = ref<HTMLElement | null>(null)
  const open = ref(false)
  const position = ref<CSSProperties>({ visibility: 'hidden' })

  function close(restoreFocus = false): void {
    open.value = false
    if (restoreFocus) (anchor.value?.querySelector<HTMLElement>('input, button') ?? anchor.value)?.focus()
  }
  function place(): void {
    if (!anchor.value || !panel.value) return
    const rect = anchor.value.getBoundingClientRect()
    if (!rect.width) { close(); return }
    const margin = 12
    const gap = 8
    const w = Math.min(width ?? Math.max(rect.width, 180), window.innerWidth - margin * 2)
    const below = window.innerHeight - rect.bottom - margin - gap
    const above = rect.top - margin - gap
    const desired = Math.min(panel.value.scrollHeight, 380)
    const upwards = below < desired && above > below
    const maxHeight = Math.max(100, upwards ? above : below)
    const height = Math.min(desired, maxHeight)
    position.value = {
      position: 'fixed', width: w + 'px',
      left: Math.max(margin, Math.min(rect.left, window.innerWidth - w - margin)) + 'px',
      top: (upwards ? Math.max(margin, rect.top - gap - height) : rect.bottom + gap) + 'px',
      maxHeight: maxHeight + 'px',
    }
  }
  async function show(): Promise<void> {
    position.value = { visibility: 'hidden' }
    open.value = true
    await nextTick()
    place()
  }
  function toggle(): void { if (open.value) close(); else void show() }

  watch(open, (visible, _, cleanup) => {
    if (!visible) return
    const outside = (e: PointerEvent) => {
      const path = e.composedPath()
      if (!path.includes(anchor.value!) && !path.includes(panel.value!)) close()
    }
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const observer = new ResizeObserver(place)
    if (anchor.value) observer.observe(anchor.value)
    if (panel.value) observer.observe(panel.value)
    cleanup(() => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      observer.disconnect()
    })
  }, { flush: 'post' })

  return { anchor, panel, open: readonly(open), position: readonly(position), show, close, toggle }
}
