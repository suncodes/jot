export function compareVersions(first: string, second: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/.exec(value)
    if (!match) throw new Error('应用版本格式无效')
    return { parts: match.slice(1, 4).map(part => BigInt(part!)), prerelease: match[4]?.split('.') }
  }
  const left = parse(first), right = parse(second)
  for (let index = 0; index < 3; index++) {
    if (left.parts[index]! < right.parts[index]!) return -1
    if (left.parts[index]! > right.parts[index]!) return 1
  }
  if (!left.prerelease || !right.prerelease) return left.prerelease ? -1 : right.prerelease ? 1 : 0
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const leftPart = left.prerelease[index], rightPart = right.prerelease[index]
    if (leftPart === rightPart) continue
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumeric = /^\d+$/.test(leftPart), rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      if (BigInt(leftPart) === BigInt(rightPart)) continue
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}
