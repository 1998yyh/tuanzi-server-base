/**
 * SSE 流式执行异常分类。
 *
 * 背景：流式接口（POST /conversations/:id/messages?stream=true）在 res.flushHeaders() 之后
 * 才开始迭代上游 LLM，此时 HTTP 状态码已定为 200、无法再改成 4xx/5xx，中途异常只能以 SSE
 * `error` 事件的形式写进流里。为避免把上游原始错误（可能含网关内部细节）暴露给前端，这里把
 * 异常归类成有限的几个 code + 固定中文文案；完整原文只进服务端日志，不外泄。
 */

export type StreamErrorCode =
  | 'MODEL_CONFIG_ERROR' // 4xx（401/400/403/404）：模型 id / 密钥 / provider / baseUrl 配错
  | 'RATE_LIMIT' // 429：调用过于频繁
  | 'UPSTREAM_ERROR' // 5xx：上游模型服务故障
  | 'AGENT_EXECUTION_ERROR'; // 其它 / 未知

export interface StreamErrorInfo {
  code: StreamErrorCode;
  message: string;
}

/**
 * 从异常里尽力提取 HTTP 状态码。
 * 优先读结构化字段（SDK 错误对象常带 status / response.status），
 * 回退到从 message 开头抓 3 位数字——LangChain 常把上游响应拼成 `"401 {...json...}"`。
 */
function extractStatus(e: unknown): number | null {
  if (e && typeof e === 'object') {
    const obj = e as { status?: unknown; response?: { status?: unknown } };
    if (typeof obj.status === 'number') return obj.status;
    if (obj.response && typeof obj.response.status === 'number') return obj.response.status;
  }
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const match = message.match(/^\s*(\d{3})\b/);
  if (match) return Number(match[1]);
  return null;
}

/**
 * 把任意异常映射为前端可读的 { code, 固定中文文案 }。不含任何上游原文。
 */
export function classifyStreamError(e: unknown): StreamErrorInfo {
  const status = extractStatus(e);

  if (status === 429) {
    return { code: 'RATE_LIMIT', message: '模型服务调用过于频繁，请稍后重试' };
  }
  if (status !== null && status >= 400 && status < 500) {
    return {
      code: 'MODEL_CONFIG_ERROR',
      message: '模型配置错误，请检查 Agent 的 provider / model / 密钥设置',
    };
  }
  if (status !== null && status >= 500) {
    return { code: 'UPSTREAM_ERROR', message: '模型服务暂时不可用，请稍后重试' };
  }

  return { code: 'AGENT_EXECUTION_ERROR', message: 'Agent 执行异常，请稍后重试' };
}
