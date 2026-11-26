import { describe, expect, it } from 'vitest'
import { calculate } from '../../electron/agent/calculator'

describe('受限十进制计算器', () => {
  it.each([
    ['0.1 + 0.2', '0.3'],
    ['sum(0.1,0.2,1.7)', '2'],
    ['9007199254740993 + 1', '9007199254740994'],
    ['(125-100)/100*100', '25'],
    ['200 * (1 + 10%)', '220'],
    ['2^3^2', '512'],
    ['-2^2', '-4'],
    ['(-2)^2', '4'],
    ['2^-3', '0.125'],
    ['1.25e3/2.5E1', '50'],
    ['mean(1,2,6)', '3'],
    ['max(1,min(-2,3),abs(-4))', '4'],
    ['sqrt(2.25)', '1.5'],
    ['round(10/3,2)', '3.33'],
    ['round(-1.235,2)', '-1.24'],
    ['round(3.14)', '3'],
    ['1e-1000 * 1e1000', '1'],
    ['-0', '0'],
  ])('%s按十进制规则返回%s', (expression, result) => {
    expect(calculate(expression)).toEqual({ expression, result, precision: 40 })
  })
  it('循环小数、开方按40位有效数字表示，结果以字符串保留大数精度', () => {
    expect(calculate('1/3').result).toBe('0.' + '3'.repeat(40))
    expect(calculate('sqrt(2)').result).toBe('1.41421356237309504880168872420969807857')
    expect(calculate('1e1000').result).toBe('1e+1000')
  })
  it.each(['', '1/0', '0^-1', 'sqrt(-1)', '2^0.5', '2^1001', '1e1001', '1e-1001', '1e-999999999999999999999',
    'round(1,21)', 'round(1,-1)', 'round(1,0.5)', 'round(1,2,3)', 'abs(1,2)', 'sum()', '(1+2', '1+',
    '20%%', '2(3)', '2**3', 'x=1', 'process.exit()', 'import("fs")', 'constructor(1)', 'sin(1)', 'max([1,2])', '1;2', '1.2.3'])('拒绝无效运算或非数值输入：%s', expression => {
    expect(() => calculate(expression)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })
  it('表达式长度、层级、词法数量、数字和函数项数有界，后续正常计算不受错误影响', () => {
    for (const expression of ['1'.repeat(2049), '('.repeat(33) + '1' + ')'.repeat(33), '1+'.repeat(257) + '1',
      '1'.repeat(101), '9.' + '9'.repeat(45) + 'e1000', 'sum(' + Array.from({ length: 101 }, () => '1').join(',') + ')'])
      expect(() => calculate(expression)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(calculate('2+3').result).toBe('5')
  })
})
