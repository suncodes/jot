/** 与主进程的文件路径约定一致，渲染端不依赖 Node。 */
export const isAbsoluteFilePath = (value: string): boolean => /^(?:[a-z]:[\\/]|\/)/i.test(value)

export function absoluteFileHref(file: string): string {
  const normalized = file.replace(/\\/g, '/')
  const url = normalized.startsWith('//') ? 'file:' + normalized : 'file://' + (/^[a-z]:\//i.test(normalized) ? '/' : '') + normalized
  return encodeURI(url).replace(/[?#()[\]]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
}
