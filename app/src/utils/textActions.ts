import { redo, redoDepth, undo, undoDepth, selectAll } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'

export type TextAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'copyAll' | 'copyMarkdown' | 'find' | 'edit'

export function editorAt(element: HTMLElement): EditorView | null {
  return EditorView.findFromDOM(element.querySelector('.cm-content') ?? element)
}

function selectionRanges(element: HTMLElement): Range[] {
  const selection = window.getSelection()
  return Array.from({ length: selection?.rangeCount ?? 0 }, (_, i) => selection!.getRangeAt(i))
    .filter((range) => element.contains(range.commonAncestorContainer))
}

export function selectedText(element: HTMLElement): string {
  const view = editorAt(element)
  if (view) return view.state.selection.ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join('\n')
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element instanceof HTMLInputElement && element.type === 'password') return ''
    return element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0)
  }
  return selectionRanges(element).map((range) => range.toString()).join('\n')
}

/** 菜单取得焦点后，仍对打开菜单时的目标和选区执行操作。 */
export function preserveTextSelection(element: HTMLElement): () => void {
  const view = editorAt(element)
  const previous = document.activeElement
  const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null
  const start = input?.selectionStart
  const end = input?.selectionEnd
  const direction = input?.selectionDirection
  const ranges = selectionRanges(element).map((range) => range.cloneRange())
  return () => {
    if (!element.isConnected) return
    if (view) { view.focus(); return }
    element.focus({ preventScroll: true })
    if (document.activeElement !== element && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    if (input && start != null && end != null) input.setSelectionRange(start, end, direction ?? 'none')
    else if (!input && ranges.length) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      ranges.forEach((range) => selection?.addRange(range))
    }
  }
}

export function historyAvailable(element: HTMLElement, action: 'undo' | 'redo'): boolean {
  const view = editorAt(element)
  return view ? (action === 'undo' ? undoDepth(view.state) : redoDepth(view.state)) > 0 : document.queryCommandEnabled(action)
}

export async function applyTextAction(element: HTMLElement, action: TextAction, selection: string): Promise<void> {
  const view = editorAt(element)
  if (action === 'copy' || action === 'copyAll' || action === 'copyMarkdown') {
    const all = view?.state.doc.toString() ?? (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText)
    await navigator.clipboard.writeText(action === 'copy' ? selection : action === 'copyMarkdown' ? element.dataset.markdown ?? all : all)
    return
  }
  element.focus({ preventScroll: true })
  if (action === 'find') {
    window.dispatchEvent(new CustomEvent('jot:find', { detail: element }))
    return
  }
  if (action === 'edit') {
    element.dispatchEvent(new CustomEvent('jot:edit', { bubbles: true }))
    return
  }
  if (view) {
    view.focus()
    if (action === 'undo') undo(view)
    else if (action === 'redo') redo(view)
    else if (action === 'selectAll') selectAll(view)
    else if (action === 'cut') {
      await navigator.clipboard.writeText(selection)
      view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut' })
    } else if (action === 'paste') {
      const text = await navigator.clipboard.readText()
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste' })
    }
    return
  }
  if (action === 'paste') document.execCommand('insertText', false, await navigator.clipboard.readText())
  else if (action === 'cut') {
    await navigator.clipboard.writeText(selection)
    document.execCommand('delete')
  } else if (action === 'selectAll') {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select()
    else {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }
  } else document.execCommand(action)
}
