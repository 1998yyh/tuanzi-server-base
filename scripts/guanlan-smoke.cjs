/* Local integration smoke: real Nest HTTP/JWT/MySQL, deterministic market/AI doubles.
 * Prepare an isolated guanlan_test* database with the documented DDL, set DB_* and
 * run: node scripts/guanlan-smoke.cjs. Never run against the application database.
 */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
if (!/^guanlan_test(?:_|$)/.test(process.env.DB_DATABASE || '')) {
  throw new Error('DB_DATABASE must be an isolated guanlan_test* database');
}
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.AGENT_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { SchedulerRegistry } = require('@nestjs/schedule');
const { DataSource } = require('typeorm');
const { AppModule } = require('../src/app.module');
const { AgentExecutorService } = require('../src/agents/agent-executor.service');
const { AgentConfig } = require('../src/agents/entities/agent-config.entity');
const { AiChannel } = require('../src/ai-generation/entities/ai-channel.entity');
const { StockMarketService } = require('../src/stock-market');
const { StockAlertsService } = require('../src/stock-alerts/stock-alerts.service');
const { ResearchConversation } = require('../src/stock-research/research-conversation.entity');
const { Message } = require('../src/agents/entities/message.entity');
const { AgentCheckpoint } = require('../src/agents/entities/agent-checkpoint.entity');
const { encrypt } = require('../src/common/utils/crypto.util');
const fullAgent = process.env.GUANLAN_AGENT_HTTP === '1';

const bars = [];
const today = new Date();
for (let days = 240; days >= 1; days--) {
  const day = new Date(today);
  day.setUTCDate(day.getUTCDate() - days);
  if ([0, 6].includes(day.getUTCDay())) continue;
  const close = 100 + bars.length;
  bars.push({
    time: day.toISOString().slice(0, 10),
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1000,
    complete: true,
  });
}
const market = {
  getBars: async (code, period, adjustment) => ({
    code,
    period,
    adjustment,
    items: bars,
    indicators: [],
    source: 'integration-test-fixture',
    fetchedAt: new Date().toISOString(),
  }),
  getIndexBars: async (code, period) => ({
    code,
    period,
    items: bars,
    source: 'integration-test-fixture',
    fetchedAt: new Date().toISOString(),
  }),
  getCatalog: async () => ({
    items: [{ code: '600519', name: '贵州茅台' }],
    coverage: 'integration-test-fixture',
  }),
  getQuotes: async () => ({
    items: [],
    source: 'integration-test-fixture',
    fetchedAt: new Date().toISOString(),
  }),
};
let lastPrompt = '';
let lastModelMessages = [];
const executor = {
  async *runStream(agent, _id, content) {
    lastPrompt = agent.systemPrompt;
    if (content === 'test-error') throw new Error('test model failure');
    yield { type: 'text_delta', data: { text: '测试回复' } };
    yield { type: 'message_end', data: { content: '测试回复', toolCalls: [], totalTokens: 1 } };
  },
};

async function main() {
  // Optional complete Agent/LangGraph/checkpoint path against a loopback model fixture.
  // This is protocol validation, not a real model evaluation; no provider is called.
  const modelServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    lastModelMessages = body.messages;
    lastPrompt = body.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    if (body.messages.at(-1)?.content === 'test-error') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ error: { message: 'test model failure', type: 'invalid_request_error' } }),
      );
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = {
      id: 'chatcmpl-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-4o-mini',
    };
    for (const data of [
      {
        ...base,
        choices: [
          { index: 0, delta: { role: 'assistant', content: '测试回复' }, finish_reason: null },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ])
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  if (fullAgent) await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(StockMarketService)
    .useValue(market);
  if (!fullAgent) builder = builder.overrideProvider(AgentExecutorService).useValue(executor);
  const module = await builder.compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  await app.listen(0, '127.0.0.1');
  for (const job of module.get(SchedulerRegistry).getCronJobs().values()) job.stop();
  const base = await app.getUrl();
  let checks = 0;
  const request = async (method, path, body, token, status = 200) => {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    assert.equal(response.status, status, method + ' ' + path + ': ' + raw);
    if (method === 'POST' && path.endsWith('/messages') && status === 200) {
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      for (const line of raw.split('\n').filter((line) => line.startsWith('data: ')))
        JSON.parse(line.slice(6));
    }
    checks++;
    return response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(raw)
      : raw;
  };
  try {
    const suffix = randomBytes(5).toString('hex');
    const password = randomBytes(18).toString('hex');
    const auth = await request(
      'POST',
      '/auth/register',
      { username: 'smoke' + suffix, email: suffix + '@example.test', password },
      null,
      201,
    );
    const token = auth.accessToken;
    const other = (
      await request(
        'POST',
        '/auth/register',
        { username: 'other' + suffix, email: 'other' + suffix + '@example.test', password },
        null,
        201,
      )
    ).accessToken;
    await request('POST', '/auth/login', { login: 'smoke' + suffix, password });
    await request('POST', '/auth/refresh', { refreshToken: auth.refreshToken });
    const user = await request('GET', '/auth/profile', undefined, token);
    await request('GET', '/stock-research/watchlist', undefined, undefined, 401);
    const watch = await request(
      'POST',
      '/stock-research/watchlist',
      { code: '600519', name: '贵州茅台', reason: '测试观察' },
      token,
      201,
    );
    await request(
      'POST',
      '/stock-research/watchlist',
      { code: '600519', name: '贵州茅台' },
      token,
      409,
    );
    assert.equal(
      (await request('GET', '/stock-research/watchlist', undefined, other)).items.length,
      0,
    );
    await request('DELETE', '/stock-research/watchlist/' + watch.id, undefined, other, 404);
    const templates = await request('GET', '/stock-strategies/templates', undefined, token);
    assert.equal(templates.items.length, 5);
    const definition = templates.items.find((x) => x.id === 'ma-above').definition;
    const strategy = await request(
      'POST',
      '/stock-strategies',
      { name: '测试策略' + suffix, definition },
      token,
      201,
    );
    await request('GET', '/stock-strategies/' + strategy.id, undefined, other, 404);
    const edited = await request(
      'PUT',
      '/stock-strategies/' + strategy.id,
      { name: '修改策略' + suffix, definition, version: 1 },
      token,
    );
    assert.equal(edited.version, 2);
    await request(
      'PUT',
      '/stock-strategies/' + strategy.id,
      { name: '旧版本', definition, version: 1 },
      token,
      409,
    );
    const run = await request(
      'POST',
      '/stock-screening/runs',
      { strategyId: strategy.id },
      token,
      201,
    );
    let result;
    for (let n = 0; n < 50; n++) {
      result = await request('GET', '/stock-screening/runs/' + run.id, undefined, token);
      if (['done', 'failed'].includes(result.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(result.status, 'done');
    assert.equal(result.total, 1, 'new watchlist must be used by screening');
    assert.equal(result.items[0].code, '600519');
    assert.ok(result.strategySnapshot, 'AI must receive strategy evidence');
    await request('GET', '/stock-screening/runs/' + run.id, undefined, other, 404);
    const db = module.get(DataSource);
    const channel = await db.getRepository(AiChannel).save({
      userId: user.id,
      name: 'isolated-test',
      apiFormat: 'openai',
      baseUrl: fullAgent
        ? 'http://127.0.0.1:' + modelServer.address().port + '/v1'
        : 'http://127.0.0.1:1',
      apiKeyEncrypted: encrypt('isolated-fixture-key', process.env.AGENT_ENCRYPTION_KEY),
      models: [{ name: 'gpt-4o-mini', capability: 'chat' }],
      isActive: true,
    });
    const agent = await db.getRepository(AgentConfig).save({
      userId: user.id,
      name: 'isolated-test',
      channelId: channel.id,
      modelName: 'gpt-4o-mini',
      systemPrompt: '原始配置',
      enabledTools: [],
      isActive: true,
    });
    const conversation = await request(
      'POST',
      '/stock-research/conversations',
      { agentId: agent.id, context: { kind: 'screen', screeningRunId: run.id } },
      token,
      201,
    );
    await request('GET', '/stock-research/conversations/' + conversation.id, undefined, other, 404);
    await request(
      'GET',
      '/stock-research/conversations/' + conversation.id + '/messages',
      undefined,
      other,
      404,
    );
    await request(
      'POST',
      '/stock-research/conversations/' + conversation.id + '/messages',
      { content: '越权' },
      other,
      404,
    );
    await request(
      'DELETE',
      '/stock-research/conversations/' + conversation.id,
      undefined,
      other,
      404,
    );
    const stream = await request(
      'POST',
      '/stock-research/conversations/' + conversation.id + '/messages',
      { content: '比较这些股票' },
      token,
    );
    assert.match(stream, /event: message_end/);
    assert.match(lastPrompt, /600519/);
    assert.match(lastPrompt, /MA/);
    assert.equal(
      (await db.getRepository(AgentConfig).findOneByOrFail({ id: agent.id })).systemPrompt,
      '原始配置',
    );
    let history = await request(
      'GET',
      '/stock-research/conversations/' + conversation.id + '/messages',
      undefined,
      token,
    );
    assert.equal(history.total, 2);
    assert.equal(history.items[1].content, '比较这些股票');
    await request(
      'POST',
      '/stock-research/conversations/' + conversation.id + '/messages',
      { content: '继续' },
      token,
    );
    history = await request(
      'GET',
      '/stock-research/conversations/' + conversation.id + '/messages',
      undefined,
      token,
    );
    assert.equal(history.total, 4);
    if (fullAgent) {
      assert.ok(
        lastModelMessages.some(
          (message) => message.role === 'assistant' && message.content === '测试回复',
        ),
        'previous turn must reach the model through checkpoint',
      );
      assert.ok(
        await db.getRepository(AgentCheckpoint).countBy({ threadId: conversation.id }),
        'real Agent must persist checkpoint',
      );
    }
    const failure = await request(
      'POST',
      '/stock-research/conversations/' + conversation.id + '/messages',
      { content: 'test-error' },
      token,
    );
    assert.match(failure, /event: error/);
    assert.equal(
      (
        await request(
          'GET',
          '/stock-research/conversations/' + conversation.id + '/messages',
          undefined,
          token,
        )
      ).total,
      4,
    );
    const alert = await request(
      'POST',
      '/stock-research/alerts',
      { code: '600519', field: 'price', operator: 'gte', threshold: 10 },
      token,
      201,
    );
    const alerts = module.get(StockAlertsService);
    const observation = { value: 11, observedAt: '2026-09-11T02:00:00.000Z' };
    await Promise.all([
      alerts.applyObservation(alert.id, observation, new Date()),
      alerts.applyObservation(alert.id, observation, new Date()),
    ]);
    await alerts.applyObservation(
      alert.id,
      { value: 9, observedAt: '2026-09-11T01:59:00.000Z' },
      new Date(),
    );
    await alerts.applyObservation(alert.id, observation, new Date());
    const events = await request('GET', '/stock-research/alert-events', undefined, token);
    assert.equal(events.total, 1, 'concurrent and out-of-order quotes must not duplicate events');
    await request(
      'POST',
      '/stock-research/alert-events/' + events.items[0].id + '/read',
      {},
      other,
      404,
    );
    await request(
      'POST',
      '/stock-research/alert-events/' + events.items[0].id + '/read',
      {},
      token,
      201,
    );
    await db.getRepository(AgentConfig).update(agent.id, { isActive: false });
    assert.equal(
      (
        await request(
          'GET',
          '/stock-research/conversations/' + conversation.id + '/messages',
          undefined,
          token,
        )
      ).total,
      4,
    );
    await request(
      'DELETE',
      '/stock-research/conversations/' + conversation.id,
      undefined,
      token,
      204,
    );
    assert.equal(
      await db.getRepository(ResearchConversation).countBy({ conversationId: conversation.id }),
      0,
    );
    assert.equal(await db.getRepository(Message).countBy({ conversationId: conversation.id }), 0);
    assert.equal(await db.getRepository(AgentCheckpoint).countBy({ threadId: conversation.id }), 0);
    await request('DELETE', '/stock-research/alerts/' + alert.id, undefined, token, 204);
    await request('DELETE', '/stock-research/watchlist/' + watch.id, undefined, token, 204);
    await request(
      'DELETE',
      '/stock-strategies/' + strategy.id + '?version=2',
      undefined,
      token,
      204,
    );
    console.log(
      JSON.stringify({
        status: 'PASS',
        httpChecks: checks,
        database: process.env.DB_DATABASE,
        ai: fullAgent ? 'real-agent-loopback-model-fixture' : 'test-double',
        market: 'test-fixture',
        verified: [
          'JWT',
          'strategy-versioning',
          'watchlist-screening',
          'research-SSE-history-delete',
          'owner-isolation',
          'alert-transaction-deduplication',
        ],
      }),
    );
  } finally {
    await app.close();
    if (fullAgent) await new Promise((resolve) => modelServer.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
