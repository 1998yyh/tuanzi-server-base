import { assertEncryptionKey, decrypt, encrypt, maskApiKey } from 'src/agents/utils/crypto.util';

// 64 位十六进制测试 key（32 字节）
const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('crypto.util', () => {
  describe('encrypt / decrypt', () => {
    it('加解密 round-trip 应该还原原文', () => {
      const plaintext = 'sk-ant-api03-abcdefg123456';
      const encrypted = encrypt(plaintext, TEST_KEY);
      expect(encrypted).not.toContain(plaintext);
      expect(decrypt(encrypted, TEST_KEY)).toBe(plaintext);
    });

    it('相同明文两次加密的密文应该不同（IV 随机）', () => {
      const plaintext = 'same-plaintext';
      expect(encrypt(plaintext, TEST_KEY)).not.toBe(encrypt(plaintext, TEST_KEY));
    });

    it('密文格式应该是 hex(iv):hex(ciphertext+tag)', () => {
      const encrypted = encrypt('test', TEST_KEY);
      const [iv, data] = encrypted.split(':');
      expect(iv).toMatch(/^[0-9a-f]{24}$/); // 12 字节 IV
      expect(data.length).toBeGreaterThan(32); // 密文 + 16 字节 tag
    });

    it('用错误的 key 解密应该抛错', () => {
      const encrypted = encrypt('secret', TEST_KEY);
      const wrongKey = TEST_KEY.replace(/^../, 'ff');
      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });

    it('密文被篡改后解密应该抛错（GCM 完整性校验）', () => {
      const encrypted = encrypt('secret', TEST_KEY);
      const [iv, data] = encrypted.split(':');
      const tampered = `${iv}:${data.slice(0, -2)}${data.endsWith('00') ? '01' : '00'}`;
      expect(() => decrypt(tampered, TEST_KEY)).toThrow();
    });

    it('格式非法的密文应该抛出明确错误', () => {
      expect(() => decrypt('not-valid-format', TEST_KEY)).toThrow(
        '密文格式非法，预期 hex(iv):hex(ciphertext+tag)',
      );
    });
  });

  describe('assertEncryptionKey', () => {
    it('64 位 hex 应该通过校验', () => {
      expect(() => assertEncryptionKey(TEST_KEY)).not.toThrow();
    });

    it('长度不对或非 hex 字符应该抛错', () => {
      expect(() => assertEncryptionKey('too-short')).toThrow(
        'AGENT_ENCRYPTION_KEY 必须是 64 个十六进制字符',
      );
      expect(() => assertEncryptionKey('z'.repeat(64))).toThrow();
      expect(() => assertEncryptionKey('')).toThrow();
    });
  });

  describe('maskApiKey', () => {
    it('应该只保留后 4 位', () => {
      expect(maskApiKey('sk-ant-api03-abcdefg123456')).toBe('****3456');
    });

    it('key 长度不足 4 位时整体保留', () => {
      expect(maskApiKey('abc')).toBe('****abc');
    });
  });
});
