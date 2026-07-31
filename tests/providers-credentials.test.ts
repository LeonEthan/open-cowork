import { describe, expect, it } from 'vitest';
import {
  API_KEY_MASK,
  decryptApiKey,
  encryptApiKey,
  validateApiKey,
} from '../src/main/providers/credentials';
import type { Encryptor } from '../src/main/providers/credentials';

/**
 * 凭证加解密往返（ticket #21，注入式 encryptor 接缝）：
 * vitest 用可逆测试 encryptor（不起 Electron）；生产为 safeStorage 实现
 * （src/main/providers/runtime.ts，e2e 覆盖真加密链路）。
 */

/** 可逆测试 encryptor：base64(明文 + 固定前缀)——模拟「密文与明文明显不同且可逆」 */
const testEncryptor: Encryptor = {
  encrypt: (plain) => Buffer.from(`v1:${plain}`, 'utf8').toString('base64'),
  decrypt: (b64) => {
    const raw = Buffer.from(b64, 'base64').toString('utf8');
    if (!raw.startsWith('v1:')) throw new Error('密文损坏');
    return raw.slice(3);
  },
};

describe('providers/credentials（#21 加解密往返）', () => {
  it('encrypt → decrypt 往返还原明文', () => {
    const key = 'sk-test-1234567890abcdef';
    const cipher = encryptApiKey(testEncryptor, key);
    expect(decryptApiKey(testEncryptor, cipher)).toBe(key);
  });

  it('密文为 base64 且不含明文本体', () => {
    const key = 'sk-plaintext-must-not-appear';
    const cipher = encryptApiKey(testEncryptor, key);
    expect(cipher).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(cipher).not.toContain(key);
    expect(cipher).not.toContain('sk-plaintext');
  });

  it('解密失败抛错（不得静默返回空串兜底）', () => {
    const bad = Buffer.from('corrupted', 'utf8').toString('base64');
    expect(() => decryptApiKey(testEncryptor, bad)).toThrow('密文损坏');
  });

  it('validateApiKey：空白/空串拒绝；前后空白 trim', () => {
    expect(() => validateApiKey('')).toThrow('不能为空');
    expect(() => validateApiKey('   ')).toThrow('不能为空');
    expect(() => validateApiKey('sk has space')).toThrow('空白');
    expect(validateApiKey('  sk-ok  ')).toBe('sk-ok');
  });

  it('encryptApiKey 先校验（空密钥不落库）', () => {
    expect(() => encryptApiKey(testEncryptor, '')).toThrow('不能为空');
  });

  it('UI 掩码为固定占位（不泄露长度与前后缀）', () => {
    expect(API_KEY_MASK).toBe('••••••••');
  });
});
