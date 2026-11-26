export interface MenuAction {
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
  separated?: boolean
  testId?: string
}

/** 用户目录允许混放笔记和原件，系统目录仍由所属功能维护。 */
export function folderArea(path: string): 'content' | null {
  return /^(content|inbox|ideas)(\/|$)/.test(path) ? 'content' : null
}
export function canManageFolder(path: string): boolean { return !!folderArea(path) && path.includes('/') }
