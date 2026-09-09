import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { assertPublicUrl } from '../../common/utils/ssrf.util';

const EXTENSIONS: Record<string, string> = {
  png: 'png',
  jpg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  avif: 'avif',
};
const MAX_BYTES = 20 * 1024 * 1024;

/** 导入工具使用：按原 URL 去重，真实格式嗅探，每次跳转都重新校验公网地址。 */
export async function mirrorPromptImage(url: string, directory: string): Promise<string> {
  const hash = createHash('sha256').update(url).digest('hex');
  await mkdir(directory, { recursive: true });
  for (const ext of Object.values(EXTENSIONS)) {
    if (
      await stat(join(directory, `${hash}.${ext}`))
        .then((s) => s.isFile())
        .catch(() => false)
    ) {
      return `/uploads/prompts/${hash}.${ext}`;
    }
  }
  const signal = AbortSignal.timeout(30_000);
  let next = url;
  for (let hop = 0; hop <= 5; hop++) {
    const safeUrl = await assertPublicUrl(next);
    const response = await fetch(safeUrl, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('图片重定向缺少地址');
      next = new URL(location, safeUrl).toString();
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`图片下载失败（HTTP ${response.status}）`);
    if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) {
      await response.body.cancel();
      throw new Error('图片超过 20MB');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('图片超过 20MB');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const buffer = Buffer.concat(chunks);
    const info = imageSize(buffer);
    const ext = info.type && EXTENSIONS[info.type];
    if (!ext || !info.width || !info.height) throw new Error('图片格式无效');
    const name = `${hash}.${ext}`;
    const temporary = join(directory, `${hash}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, buffer);
      await rename(temporary, join(directory, name));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return `/uploads/prompts/${name}`;
  }
  throw new Error('图片重定向次数过多');
}
