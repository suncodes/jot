import Decimal from 'decimal.js'
import { JotError } from '@shared/result'

// 仅解析数值、括号和固定函数，不把用户表达式交给JavaScript或通用脚本求值器。
const NumberValue = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -20, toExpPos: 40 })
const MAX_LENGTH = 2048, MAX_TOKENS = 512, MAX_DEPTH = 32, MAX_EXPONENT = 1000
const invalid = (message: string): never => { throw new JotError('INVALID_INPUT', '计算失败：' + message) }
type Token = { text: string; offset: number }
export interface Calculation { expression: string; result: string; precision: number }

function tokensOf(expression: string): Token[] {
  const tokens: Token[] = []
  let offset = 0
  while (offset < expression.length) {
    if (/\s/.test(expression[offset]!)) { offset++; continue }
    const text = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|^[a-z]+|^[()+\-*/^%,]/.exec(expression.slice(offset))?.[0]
    if (!text) return invalid('第' + (offset + 1) + '个字符不支持；仅接受数字、算符和固定函数。')
    tokens.push({ text, offset }); offset += text.length
    if (tokens.length > MAX_TOKENS) invalid('表达式过于复杂，请分步计算。')
  }
  return tokens
}

class Parser {
  private cursor = 0
  private depth = 0
  constructor(private readonly tokens: Token[]) {}
  private peek(): string { return this.tokens[this.cursor]?.text ?? '' }
  private take(text: string): boolean { if (this.peek() !== text) return false; this.cursor++; return true }
  private expect(text: string): void { if (!this.take(text)) invalid('缺少“' + text + '”。') }
  private bounded(value: Decimal): Decimal {
    if (!value.isFinite() || !value.isZero() && Math.abs(value.e) > MAX_EXPONENT) invalid('结果超出支持范围（十进制指数绝对值不超过1000）。')
    return value
  }
  parse(): Decimal {
    if (!this.tokens.length) invalid('表达式不能为空。')
    const value = this.expression()
    if (this.cursor !== this.tokens.length) invalid('第' + (this.tokens[this.cursor]!.offset + 1) + '个字符附近缺少运算符或有多余内容。')
    return this.bounded(value.toSignificantDigits(40))
  }
  private expression(): Decimal {
    let value = this.product()
    while (this.peek() === '+' || this.peek() === '-') {
      const subtract = this.take('-'); if (!subtract) this.expect('+')
      const next = this.product()
      value = this.bounded(subtract ? value.minus(next) : value.plus(next))
    }
    return value
  }
  private product(): Decimal {
    let value = this.unary()
    while (this.peek() === '*' || this.peek() === '/') {
      const divide = this.take('/'); if (!divide) this.expect('*')
      const next = this.unary()
      if (divide && next.isZero()) invalid('不能除以零。')
      value = this.bounded(divide ? value.div(next) : value.mul(next))
    }
    return value
  }
  private unary(): Decimal {
    if (++this.depth > MAX_DEPTH) invalid('括号或嵌套超过32层，请分步计算。')
    try {
      if (this.take('+')) return this.unary()
      if (this.take('-')) return this.unary().neg()
      let value = this.primary()
      if (this.take('%')) value = this.bounded(value.div(100))
      if (this.take('^')) {
        const exponent = this.unary()
        if (!exponent.isInteger() || exponent.abs().gt(MAX_EXPONENT)) invalid('幂指数必须为-1000到1000的整数。')
        if (value.isZero() && exponent.isNegative()) invalid('零不能取负次幂。')
        value = this.bounded(value.pow(exponent))
      }
      return value
    } finally { this.depth-- }
  }
  private primary(): Decimal {
    if (this.take('(')) { const value = this.expression(); this.expect(')'); return value }
    const text = this.peek()
    if (/^[\d.]/.test(text)) {
      this.cursor++
      if (text.length > 100) invalid('单个数字过长，请缩短到100个字符以内。')
      const exponent = /[eE]([+-]?\d+)$/.exec(text)?.[1]
      if (exponent && Math.abs(Number(exponent)) > MAX_EXPONENT) invalid('数字的科学计数指数必须在-1000到1000之间。')
      return this.bounded(new NumberValue(text))
    }
    if (/^[a-z]+$/.test(text)) {
      this.cursor++
      if (!['abs', 'sqrt', 'round', 'sum', 'mean', 'min', 'max'].includes(text)) invalid('不支持函数“' + text + '”。可用abs、sqrt、round、sum、mean、min、max。')
      this.expect('(')
      const values = [this.expression()]
      while (this.take(',')) {
        if (values.length >= 100) invalid('单个函数最多接受100个数。')
        values.push(this.expression())
      }
      this.expect(')')
      return this.bounded(this.fn(text, values))
    }
    return invalid('需要数字、括号或固定函数。')
  }
  private fn(name: string, values: Decimal[]): Decimal {
    const first = values[0]!
    if (name === 'abs' || name === 'sqrt') {
      if (values.length !== 1) invalid(name + '只接受一个数。')
      if (name === 'sqrt' && first.isNegative()) invalid('负数不能在实数范围开平方。')
      return name === 'abs' ? first.abs() : first.sqrt()
    }
    if (name === 'round') {
      if (values.length > 2) invalid('round接受一个数和可选的小数位数。')
      const places = values[1] ?? new NumberValue(0)
      if (!places.isInteger() || places.lt(0) || places.gt(20)) invalid('round的小数位数必须为0到20的整数。')
      return first.toDecimalPlaces(places.toNumber())
    }
    if (name === 'min' || name === 'max') return name === 'min' ? NumberValue.min(...values) : NumberValue.max(...values)
    const sum = values.reduce((total, value) => this.bounded(total.plus(value)), new NumberValue(0))
    return name === 'mean' ? sum.div(values.length) : sum
  }
}

export function calculate(expression: string): Calculation {
  if (typeof expression !== 'string' || expression.length > MAX_LENGTH) invalid('请输入不超过2048个字符的表达式。')
  const source = expression.trim()
  const result = new Parser(tokensOf(source)).parse()
  return { expression: source, result: result.isZero() ? '0' : result.toString(), precision: 40 }
}
