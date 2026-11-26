import fs from 'node:fs'
import { JotError } from '@shared/result'

/** 只核对本次写入目标的实际内容，不维护版本或历史身份。 */
export async function verifyTextFile(absolute: string, expected: string): Promise<void> {
  let actual: string
  try { actual = await fs.promises.readFile(absolute, 'utf8') }
  catch (error) { throw new JotError('IO_ERROR', '文件已写入，但回读失败，请检查当前文件：' + (error as Error).message) }
  if (actual !== expected) throw new JotError('IO_ERROR', '文件已写入，但回读内容与本次写入不一致，请检查当前文件后再处理')
}
