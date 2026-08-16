// 2026-08-15 代码审查新增：ai-generation 出站下载统一加固工具。
// 所有「远端内容提供 URL、服务端主动 fetch 下载」的路径都应先过 assertPublicUrl，
// 再用 readBodyLimited 流式读取并限制大小（不无上限 arrayBuffer/json）。

/** 图片生成结果下载上限 */
export const MAX_IMAGE_DOWNLOAD_BYTES = 50 * 1024 * 1024;
/** 视频生成结果下载上限 */
export const MAX_VIDEO_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** 音频生成结果下载上限 */
export const MAX_AUDIO_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * 流式读取响应体并限制总字节数；超限抛错并取消连接。
 * 注意：Content-Length 头可被伪造/缺失，实际大小以流式累计为准。
 */
export async function readBodyLimited(
  response: Response,
  maxBytes: number,
  sizeError: string,
): Promise<Buffer> {
  if (!response.body) throw new Error('响应无内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(sizeError);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks);
}
