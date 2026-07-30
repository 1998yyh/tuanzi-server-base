import { classifyStreamError } from 'src/agents/utils/stream-error';

describe('classifyStreamError（流式异常分类）', () => {
  it('401 结构化 status → MODEL_CONFIG_ERROR', () => {
    const result = classifyStreamError({ status: 401, message: 'unauthorized' });
    expect(result.code).toBe('MODEL_CONFIG_ERROR');
    expect(result.message).toContain('模型配置错误');
  });

  it('400 结构化 status → MODEL_CONFIG_ERROR', () => {
    expect(classifyStreamError({ status: 400 }).code).toBe('MODEL_CONFIG_ERROR');
  });

  it('response.status=403 → MODEL_CONFIG_ERROR', () => {
    expect(classifyStreamError({ response: { status: 403 } }).code).toBe('MODEL_CONFIG_ERROR');
  });

  it('message 以 "401 {...}" 开头（LangChain 拼接串）→ 抓到状态码 MODEL_CONFIG_ERROR', () => {
    const e = new Error('401 {"error":{"type":"authentication_error","message":"..."}}');
    expect(classifyStreamError(e).code).toBe('MODEL_CONFIG_ERROR');
  });

  it('429 → RATE_LIMIT', () => {
    const result = classifyStreamError({ status: 429 });
    expect(result.code).toBe('RATE_LIMIT');
    expect(result.message).toContain('频繁');
  });

  it('500 → UPSTREAM_ERROR', () => {
    expect(classifyStreamError({ status: 500 }).code).toBe('UPSTREAM_ERROR');
  });

  it('503 → UPSTREAM_ERROR', () => {
    const result = classifyStreamError({ status: 503 });
    expect(result.code).toBe('UPSTREAM_ERROR');
    expect(result.message).toContain('暂时不可用');
  });

  it('无状态码的普通 Error → AGENT_EXECUTION_ERROR', () => {
    const result = classifyStreamError(new Error('socket hang up'));
    expect(result.code).toBe('AGENT_EXECUTION_ERROR');
    expect(result.message).toContain('Agent 执行异常');
  });

  it('非对象/非 Error（undefined）→ AGENT_EXECUTION_ERROR，不抛异常', () => {
    expect(classifyStreamError(undefined).code).toBe('AGENT_EXECUTION_ERROR');
  });

  it('返回的 message 不含任何上游原文（不泄露）', () => {
    const secret = '401 {"error":{"message":"leak-token-xyz"}}';
    const result = classifyStreamError(new Error(secret));
    expect(result.message).not.toContain('leak-token-xyz');
  });
});
