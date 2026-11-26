export const dayOf = (d: Date): string =>
  String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

export function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01' || value > '9999-12-31') return null
  const date = new Date(value + 'T12:00:00')
  return !Number.isNaN(date.getTime()) && dayOf(date) === value ? date : null
}
