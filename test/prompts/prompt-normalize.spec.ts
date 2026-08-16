import { runPromptSource, MAX_SOURCE_BYTES } from 'src/prompts/lib/prompt-normalize';

const mockFetch = jest.fn();
global.fetch = mockFetch as never;

function source(
  overrides: Partial<{ id: string; name: string; url: string; isBuiltin: boolean }> = {},
) {
  return {
    id: 'src-1',
    name: '测试源',
    url: 'https://8.8.8.8/sources/test.json',
    isBuiltin: false,
    ...overrides,
  };
}

/** 构造带可流式读取 body 的响应（runPromptSource 现在走流式读取，不再 response.json） */
function jsonResponse(body: unknown, status = 200, extra: Partial<Response> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    type: 'basic',
    headers: new Headers({
      'content-type': 'application/json',
      'content-length': String(bytes.length),
    }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    ...extra,
  } as unknown as Response;
}

describe('prompt-normalize.runPromptSource', () => {
  beforeEach(() => mockFetch.mockReset());

  it('拒绝回环地址（字面 IP，不触发真实 DNS）', async () => {
    await expect(
      runPromptSource(source({ url: 'http://127.0.0.1:8080/prompts.json' })),
    ).rejects.toThrow('禁止访问内网或保留地址');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('拒绝云元数据地址 169.254.169.254', async () => {
    await expect(
      runPromptSource(source({ url: 'http://169.254.169.254/latest/meta-data' })),
    ).rejects.toThrow('禁止访问内网或保留地址');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('拒绝私网地址 192.168.1.1 与 10.0.0.1', async () => {
    await expect(runPromptSource(source({ url: 'http://192.168.1.1/a.json' }))).rejects.toThrow(
      '禁止访问内网或保留地址',
    );
    await expect(runPromptSource(source({ url: 'http://10.0.0.1/a.json' }))).rejects.toThrow(
      '禁止访问内网或保留地址',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('拒绝非 http/https 协议（file://、ftp://）', async () => {
    await expect(runPromptSource(source({ url: 'file:///etc/passwd' }))).rejects.toThrow(
      '仅支持 http/https 协议',
    );
    await expect(runPromptSource(source({ url: 'ftp://example.com/a.json' }))).rejects.toThrow(
      '仅支持 http/https 协议',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('拒绝重定向响应（opaqueredirect）', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 0,
      type: 'opaqueredirect',
      headers: new Headers(),
    } as unknown as Response);
    await expect(runPromptSource(source())).rejects.toThrow(
      '提示词源「测试源」抓取失败，请稍后重试',
    );
    // 脱敏消息不包含原始细节
    await expect(runPromptSource(source())).rejects.not.toThrow(/重定向/);
  });

  it('拒绝 3xx 状态码（redirect: manual 下不自动跟随）', async () => {
    mockFetch.mockResolvedValue(jsonResponse('', 302));
    await expect(runPromptSource(source())).rejects.toThrow(
      '提示词源「测试源」抓取失败，请稍后重试',
    );
  });

  it('抓取网络失败时只暴露脱敏文案，不透出原始错误（DNS/TLS/状态码）', async () => {
    mockFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND internal.corp'));
    let caught: unknown;
    try {
      await runPromptSource(source());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & { cause?: unknown };
    expect(error.message).toBe('提示词源「测试源」抓取失败，请稍后重试');
    expect(error.message).not.toContain('ENOTFOUND');
    expect(error.message).not.toContain('internal.corp');
    // 原始细节挂在 cause 上供服务层记日志
    expect(String(error.cause)).toContain('ENOTFOUND');
  });

  it('Content-Length 超过 10MB 直接拒绝', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      type: 'basic',
      headers: new Headers({ 'content-length': String(MAX_SOURCE_BYTES + 1) }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        },
      }),
    } as unknown as Response);
    await expect(runPromptSource(source())).rejects.toThrow(
      '提示词源「测试源」抓取失败，请稍后重试',
    );
  });

  it('流式累计超过 10MB 中止（伪造小 Content-Length 也能拦住）', async () => {
    // Content-Length 声称 1 字节，实际流出 10MB+：以流式累计为准
    const chunk = new Uint8Array(1024 * 1024); // 1MB
    let pushed = 0;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      type: 'basic',
      headers: new Headers({ 'content-length': '1' }),
      body: new ReadableStream({
        pull(controller) {
          if (pushed >= 11) {
            controller.close();
            return;
          }
          pushed += 1;
          controller.enqueue(chunk);
        },
      }),
    } as unknown as Response);
    await expect(runPromptSource(source())).rejects.toThrow(
      '提示词源「测试源」抓取失败，请稍后重试',
    );
  });

  it('正常抓取：流式读取 + JSON 数组归一化（相对 URL 转绝对、去重、自动编号）', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        { id: 'p1', title: '猫咪', prompt: '一只猫', coverUrl: 'covers/a.png', tags: ['动物'] },
        { id: 'p1', title: '重复', prompt: 'dup' },
        { title: '无 id', prompt: '自动编号', referenceImageUrls: ['refs/b.png'] },
      ]),
    );
    const items = await runPromptSource(source());
    expect(items).toHaveLength(2);
    expect(items[0].coverUrl).toBe('https://8.8.8.8/sources/covers/a.png');
    expect(items[1].id).toBe('src-1-0003');
    expect(items[1].referenceImageUrls[0]).toBe('https://8.8.8.8/sources/refs/b.png');
  });

  it('根节点不是数组时报格式错误（内容校验，不透出抓取细节）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ foo: 'bar' }));
    await expect(runPromptSource(source())).rejects.toThrow(
      '提示词源「测试源」格式错误：根节点必须是数组',
    );
  });
});
