/** 接受JSON对象及模型常用的代码块包裹，结构和业务含义仍由调用方校验。 */
export function extractJson(text: string): unknown {
  const stripped = text.trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, '')
  const start = stripped.indexOf('{'), end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON 对象')
  return JSON.parse(stripped.slice(start, end + 1))
}
