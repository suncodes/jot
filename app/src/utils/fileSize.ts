/** 文件详情与存储维护共用的显示单位。 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = bytes, unit = 0
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++ }
  return (unit ? amount.toFixed(1) : String(amount)) + ' ' + units[unit]
}
