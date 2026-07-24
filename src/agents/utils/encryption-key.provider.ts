import { ConfigService } from '@nestjs/config';
import { assertEncryptionKey } from './crypto.util';

/** API Key 加密密钥的注入 token（值为 64 位 hex 字符串） */
export const AGENT_ENCRYPTION_KEY = Symbol('AGENT_ENCRYPTION_KEY');

/**
 * 从环境变量读取并校验加密密钥，缺失或格式非法时 fail-fast，应用拒绝启动。
 * 测试可通过 { provide: AGENT_ENCRYPTION_KEY, useValue: '<64 hex>' } 注入固定 key。
 */
export const encryptionKeyProvider = {
  provide: AGENT_ENCRYPTION_KEY,
  useFactory: (config: ConfigService): string => {
    const key = config.get<string>('AGENT_ENCRYPTION_KEY');
    if (!key) {
      throw new Error(
        '缺少环境变量 AGENT_ENCRYPTION_KEY（64 个十六进制字符，可用 `openssl rand -hex 32` 生成），应用无法启动',
      );
    }
    assertEncryptionKey(key);
    return key;
  },
  inject: [ConfigService],
};
