import { mirrorPromptImage } from 'src/prompts/lib/prompt-image-mirror';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPublicUrl } from 'src/common/utils/ssrf.util';
jest.mock('src/common/utils/ssrf.util', () => ({ assertPublicUrl: jest.fn(async (url) => url) }));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64',
);
describe('提示词图片本地化', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prompt-test-'));
    jest.clearAllMocks();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('保存真实图片，重复下载复用文件', async () => {
    global.fetch = jest.fn(
      async () => new Response(png, { headers: { 'content-type': 'image/png' } }),
    ) as never;
    const url = await mirrorPromptImage('https://example.com/a.png', dir);
    expect(url).toMatch(/^\/uploads\/prompts\/[a-f0-9]{64}\.png$/);
    expect(await readFile(join(dir, url.split('/').pop()!))).toEqual(png);
    expect(await mirrorPromptImage('https://example.com/a.png', dir)).toBe(url);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('重定向每一跳都校验公网地址', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
      ) as never;
    jest.mocked(assertPublicUrl).mockImplementation(async (url) => {
      if (url.includes('127.0.0.1')) throw new Error('拒绝私网');
      return new URL(url);
    });
    await expect(mirrorPromptImage('https://example.com/a', dir)).rejects.toThrow('拒绝私网');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('拒绝伪装为图片的 HTML', async () => {
    global.fetch = jest.fn(
      async () => new Response('<html>bad</html>', { headers: { 'content-type': 'image/png' } }),
    ) as never;
    await expect(mirrorPromptImage('https://example.com/b', dir)).rejects.toThrow();
  });
});
