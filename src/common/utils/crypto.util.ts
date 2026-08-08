import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * API Key 加解密工具（AES-256-GCM）。
 *
 * 存储格式约定（必须严格遵守，否则解密必然失败）：
 * - IV：12 字节（GCM 推荐长度），每次加密随机生成，绝不复用
 * - authTag：16 字节，由 GCM 模式自动生成
 * - 数据库存储格式：`hex(iv):hex(ciphertext + authTag)`，两段均为十六进制字符串，冒号分隔
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX_LENGTH = 64; // 32 字节 = 64 个十六进制字符

/** 校验加密 key 格式（64 位 hex），不合法直接抛错（fail-fast） */
export function assertEncryptionKey(keyHex: string): void {
  if (
    typeof keyHex !== 'string' ||
    keyHex.length !== KEY_HEX_LENGTH ||
    !/^[0-9a-f]+$/i.test(keyHex)
  ) {
    throw new Error(
      'AGENT_ENCRYPTION_KEY 必须是 64 个十六进制字符（32 字节），可用 `openssl rand -hex 32` 生成',
    );
  }
}

export function encrypt(plaintext: string, keyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${Buffer.concat([encrypted, tag]).toString('hex')}`;
}

export function decrypt(stored: string, keyHex: string): string {
  const [ivHex, dataHex] = stored.split(':');
  if (!ivHex || !dataHex) {
    throw new Error('密文格式非法，预期 hex(iv):hex(ciphertext+tag)');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const tag = data.subarray(data.length - TAG_BYTES);
  const ciphertext = data.subarray(0, data.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

/** 脱敏展示：只保留后 4 位，如 "****3xYz" */
export function maskApiKey(plaintext: string): string {
  return `****${plaintext.slice(-4)}`;
}
