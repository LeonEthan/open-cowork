/**
 * 凭证加解密接缝（ticket #21，ARCHITECTURE §3/§10：凭证不出本机）。
 *
 * Encryptor 为可注入接口：
 * - 生产：Electron safeStorage（macOS Keychain）实现，见 src/main/providers/runtime.ts；
 * - vitest：测试注入可逆 encryptor（往返断言），不起 Electron。
 *
 * 约定：密文一律 base64 字符串入库（providers.encrypted_api_key）；明文绝不落盘、
 * 绝不进 renderer（IPC DTO 只给掩码，见 services/providers.ts）。
 */

export interface Encryptor {
  /** 明文 → base64 密文 */
  encrypt: (plain: string) => string;
  /** base64 密文 → 明文（解密失败必须抛错，不得返回空串兜底） */
  decrypt: (cipherBase64: string) => string;
}

/** 密钥合法性（仅做最基本把关：非空、无空白字符——各 provider 格式不一，不猜前缀） */
export function validateApiKey(plain: string): string {
  const key = plain.trim();
  if (key.length === 0) throw new Error('API 密钥不能为空');
  if (/\s/.test(key)) throw new Error('API 密钥不能包含空白字符');
  return key;
}

/** 加密入库（返回 base64 密文） */
export function encryptApiKey(encryptor: Encryptor, plain: string): string {
  return encryptor.encrypt(validateApiKey(plain));
}

/** 解密出库（仅在 main 进程内组装 agent env / 拉取模型清单时调用） */
export function decryptApiKey(encryptor: Encryptor, cipherBase64: string): string {
  return encryptor.decrypt(cipherBase64);
}

/**
 * UI 掩码：固定占位，不解密、不泄露长度与前后缀（红线：解密只在组装 env 时发生）。
 */
export const API_KEY_MASK = '••••••••';
