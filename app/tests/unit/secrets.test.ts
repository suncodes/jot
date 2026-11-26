import { describe, expect, it, vi } from 'vitest'
import { createSecretStore, type SystemEncryption } from '../../electron/settings/secrets'

function encryption(): SystemEncryption {
  return { isEncryptionAvailable: () => true, encryptString: value => Buffer.from('isolated:' + value), decryptString: value => value.toString().slice(9) }
}

describe('系统密钥保存', () => {
  it('往返使用系统加解密，不保存密钥原文', () => {
    const system = encryption()
    const encrypt = vi.spyOn(system, 'encryptString')
    const decrypt = vi.spyOn(system, 'decryptString')
    const store = createSecretStore(system)
    const stored = store.encrypt('fixture-api-key')
    expect(stored).toMatch(/^enc:/)
    expect(stored).not.toContain('fixture-api-key')
    expect(store.decrypt(stored)).toBe('fixture-api-key')
    expect(encrypt).toHaveBeenCalledOnce()
    expect(decrypt).toHaveBeenCalledOnce()
  })
  it('系统加密不可用时拒绝写入，没有明文回退', () => {
    const system = { ...encryption(), isEncryptionAvailable: () => false }
    const encrypt = vi.spyOn(system, 'encryptString')
    expect(() => createSecretStore(system).encrypt('fixture-api-key')).toThrow('未保存')
    expect(encrypt).not.toHaveBeenCalled()
  })
  it('加密或解密错误不暴露输入值', () => {
    const system = encryption()
    system.encryptString = () => { throw new Error('fixture-api-key') }
    system.decryptString = () => { throw new Error('fixture-api-key') }
    const store = createSecretStore(system)
    expect(() => store.encrypt('fixture-api-key')).toThrow('模型密钥加密失败')
    expect(() => store.decrypt('enc:YWJj')).toThrow('模型密钥无法解密')
    expect(() => store.decrypt('raw:fixture-api-key')).toThrow('格式无效')
  })
})
