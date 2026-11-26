/** 弹窗关闭或对象行消失后，把键盘焦点交还目标或相邻对象。 */
export function restoreObjectFocus(origin: HTMLElement | null): () => void {
  const row = origin?.closest<HTMLElement>('[data-object-row]')
  const list = row?.closest<HTMLElement>('[data-object-list]')
  const rows = [...(list?.querySelectorAll<HTMLElement>('[data-object-row]') ?? [])]
  const index = row ? rows.indexOf(row) : -1
  const adjacent = index < 0 ? [] : [...rows.slice(index + 1), ...rows.slice(0, index).reverse()]
  const targetOf = (element: HTMLElement) => element.matches('[tabindex="0"]') ? element : element.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')
  const fallback = list?.parentElement?.parentElement?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []
  const targets = [origin, ...adjacent.map(targetOf), ...[...fallback].filter((element) => !row?.contains(element))]
  return () => {
    if (document.querySelector('dialog[open]') || document.activeElement !== document.body && document.activeElement?.isConnected) return
    targets.find((element) => element?.isConnected && element.getClientRects().length && !element.closest('[inert]'))?.focus({ preventScroll: true })
  }
}
