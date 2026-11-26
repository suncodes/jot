import { JotError } from '@shared/result'
import type { SecretStore } from './settings'

export interface SystemEncryption {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export function createSecretStore(storage: SystemEncryption): SecretStore {
  return {
    encrypt(plain) {
      if (!storage.isEncryptionAvailable()) throw new JotError('WRITE_DENIED', '系统密钥加密当前不可用，模型密钥未保存。请恢复系统加密后重试。')
      try { return 'enc:' + storage.encryptString(plain).toString('base64') }
      catch { throw new JotError('IO_ERROR', '模型密钥加密失败，设置未保存。') }
    },
    decrypt(stored) {
      if (!storage.isEncryptionAvailable()) throw new JotError('IO_ERROR', '系统密钥解密当前不可用。')
      if (!/^enc:[A-Za-z0-9+/]+={0,2}$/.test(stored)) throw new JotError('INVALID_INPUT', '模型密钥格式无效，请重新配置密钥。')
      try { return storage.decryptString(Buffer.from(stored.slice(4), 'base64')) }
      catch { throw new JotError('IO_ERROR', '模型密钥无法解密，请重新配置密钥。') }
    },
  }
}
