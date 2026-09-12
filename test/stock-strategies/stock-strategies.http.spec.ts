import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { StockStrategiesController } from 'src/stock-strategies/stock-strategies.controller';
import { StockStrategiesService } from 'src/stock-strategies/stock-strategies.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StockStrategy } from 'src/stock-strategies/stock-strategy.entity';
const id = '11111111-1111-4111-8111-111111111111';
const definition = {
  period: 'day',
  adjustment: 'qfq',
  scope: 'watchlist',
  match: 'all',
  conditions: [{ indicator: 'MA', parameters: [20] }],
};
class TestIdentityGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    if (req.headers.authorization !== 'Bearer test-user') return false;
    req.user = { id: 'u1' };
    return true;
  }
}
describe('策略HTTP边界（测试身份替代JWT验签）', () => {
  let app: INestApplication;
  let url: string;
  let repo: Record<string, jest.Mock>;
  beforeAll(async () => {
    repo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id, ...x })),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const mod = await Test.createTestingModule({
      controllers: [StockStrategiesController],
      providers: [
        StockStrategiesService,
        { provide: getRepositoryToken(StockStrategy), useValue: repo },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestIdentityGuard)
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
  });
  async function request(path: string, body?: unknown, auth = true) {
    return fetch(url + '/api/stock-strategies' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: 'Bearer test-user' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  it('模板接口需要身份', async () =>
    expect((await request('/templates', undefined, false)).status).toBe(403));
  it('返回五个只读模板', async () => {
    const r = await request('/templates');
    expect(r.status).toBe(200);
    expect((await r.json()).items).toHaveLength(5);
  });
  it('拒绝请求中的userId', async () =>
    expect((await request('', { name: '测试', definition, userId: 'u2' })).status).toBe(400));
  it('拒绝空白名称与嵌套非法字段', async () => {
    expect((await request('', { name: '   ', definition })).status).toBe(400);
    expect(
      (await request('', { name: '测试', definition: { ...definition, formula: 'run' } })).status,
    ).toBe(400);
  });
  it('有效创建返回201且归属来自身份', async () => {
    const r = await request('', { name: ' 我的策略 ', definition });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: '我的策略', version: 1 });
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
  });
  it('拒绝无效UUID及非法分页', async () => {
    expect((await request('/not-uuid')).status).toBe(400);
    expect((await request('?limit=101')).status).toBe(400);
    expect((await request('?page=0')).status).toBe(400);
  });
  it('未知策略返回404', async () => expect((await request('/' + id)).status).toBe(404));
  it('更新要求完整定义和版本', async () => {
    const r = await fetch(url + '/api/stock-strategies/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-user' },
      body: JSON.stringify({ name: '新名称', definition }),
    });
    expect(r.status).toBe(400);
  });
  it('删除缺少版本返回400', async () => {
    const r = await fetch(url + '/api/stock-strategies/' + id, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-user' },
    });
    expect(r.status).toBe(400);
  });
});
