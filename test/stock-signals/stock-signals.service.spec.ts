import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StockSignalsService } from 'src/stock-signals/stock-signals.service';
import { ScanRunStatus, StockSignalScanRun } from 'src/stock-signals/entities/scan-run.entity';
import { StockSignal } from 'src/stock-signals/entities/stock-signal.entity';
import { SinaScannerService } from 'src/stock-signals/sina-scanner.service';
import { UserRole } from 'src/users/users.entity';

describe('StockSignalsService', () => {
  let service: StockSignalsService;
  let runRepo: Record<string, jest.Mock>;
  let signalRepo: Record<string, jest.Mock>;
  let scanner: Record<string, jest.Mock>;

  const user = {
    id: 'user-1',
    email: 'u@test.com',
    username: 'user',
    role: UserRole.USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const makeRun = (over: Partial<StockSignalScanRun> = {}): StockSignalScanRun => ({
    id: 'run-1',
    queryDate: '2026-07-31',
    status: ScanRunStatus.DONE,
    total: 3044,
    checked: 3044,
    found: 2,
    failedCodes: [],
    createdBy: 'user-1',
    createdAt: new Date('2026-07-31T10:00:00Z'),
    updatedAt: new Date('2026-07-31T10:02:00Z'),
    ...over,
  });

  beforeEach(async () => {
    runRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ id: 'run-new', ...v })),
      update: jest.fn(),
    };
    signalRepo = {
      find: jest.fn(),
      upsert: jest.fn(),
    };
    scanner = { scan: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StockSignalsService,
        { provide: getRepositoryToken(StockSignalScanRun), useValue: runRepo },
        { provide: getRepositoryToken(StockSignal), useValue: signalRepo },
        { provide: SinaScannerService, useValue: scanner },
      ],
    }).compile();

    service = module.get(StockSignalsService);
  });

  describe('requestScan（全市场）', () => {
    it('未来日期直接 400', async () => {
      await expect(service.requestScan(user, { date: '2999-01-01' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('周末日期直接 400（周六/周日都拒绝）', async () => {
      await expect(service.requestScan(user, { date: '2026-08-01' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.requestScan(user, { date: '2026-08-02' })).rejects.toThrow(
        BadRequestException,
      );
      expect(runRepo.save).not.toHaveBeenCalled();
      expect(scanner.scan).not.toHaveBeenCalled();
    });

    it('该日期已有 done 任务且非强制刷新：返回缓存，不新建任务', async () => {
      runRepo.findOne.mockResolvedValue(makeRun());
      const res = await service.requestScan(user, { date: '2026-07-31' });
      expect(res.cached).toBe(true);
      expect(res.run?.status).toBe(ScanRunStatus.DONE);
      expect(runRepo.save).not.toHaveBeenCalled();
      expect(scanner.scan).not.toHaveBeenCalled();
    });

    it('该日期有 running 任务：复用该任务，不重复开扫', async () => {
      runRepo.findOne.mockResolvedValue(makeRun({ status: ScanRunStatus.RUNNING }));
      const res = await service.requestScan(user, { date: '2026-07-31' });
      expect(res.cached).toBe(false);
      expect(res.run?.id).toBe('run-1');
      expect(runRepo.save).not.toHaveBeenCalled();
    });

    it('无历史任务：创建新任务并异步开扫', async () => {
      // 第一次 findOne 是缓存判断（无任务），之后是 executeRun 内取任务
      runRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValue(makeRun({ status: ScanRunStatus.RUNNING }));
      scanner.scan.mockResolvedValue({ results: [], failures: [] });
      const res = await service.requestScan(user, { date: '2026-07-31' });
      expect(res.cached).toBe(false);
      expect(runRepo.save).toHaveBeenCalled();
      // 等异步 executeRun 跑完一轮
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(scanner.scan).toHaveBeenCalled();
    });

    it('强制刷新：无视 done 任务，重新开扫', async () => {
      // latestRun 返回 done（用于缓存判断），executeRun 内 findOne 返回 running 副本
      runRepo.findOne.mockResolvedValue(makeRun());
      scanner.scan.mockResolvedValue({ results: [], failures: [] });
      const res = await service.requestScan(user, { date: '2026-07-31', refresh: true });
      expect(res.cached).toBe(false);
      expect(runRepo.save).toHaveBeenCalled();
    });
  });

  describe('requestScan（指定代码）', () => {
    it('缓存命中跳过抓取，B 信号按 value=1 过滤，无效代码被收集', async () => {
      signalRepo.find.mockResolvedValue([{ signalDate: '2026-07-31', code: '600519', value: '1' }]);
      scanner.scan.mockResolvedValue({
        results: [{ item: { code: '000001', market: 'sz', name: '平安银行' }, value: '0' }],
        failures: [],
      });

      const res = await service.requestScan(user, {
        date: '2026-07-31',
        codes: ['600519', 'sz000001', '300750', 'abc'],
      });

      expect(res.result).toBeDefined();
      // 300750（创业板）与 abc 无效
      expect(res.result!.invalid).toEqual(['300750', 'abc']);
      // 600519 命中缓存，只有 000001 被抓取
      expect(scanner.scan).toHaveBeenCalledTimes(1);
      expect(scanner.scan.mock.calls[0][0].map((i: { code: string }) => i.code)).toEqual([
        '000001',
      ]);
      // 600519 value=1 是 B；000001 value=0 不是
      expect(res.result!.items).toEqual([{ code: '600519', market: 'sh', name: '贵州茅台' }]);
      // 新抓取的行落库
      expect(signalRepo.upsert).toHaveBeenCalledTimes(1);
    });

    it('强制刷新：忽略缓存全部重抓', async () => {
      scanner.scan.mockResolvedValue({ results: [], failures: [] });
      const res = await service.requestScan(user, {
        date: '2026-07-31',
        codes: ['600519'],
        refresh: true,
      });
      expect(signalRepo.find).not.toHaveBeenCalled();
      expect(scanner.scan).toHaveBeenCalledTimes(1);
      expect(res.result!.cachedCount).toBe(0);
    });
  });

  describe('结果查询', () => {
    it('getByDate：无 done 任务抛 404', async () => {
      runRepo.find.mockResolvedValue([]);
      await expect(service.getByDate('2026-07-31')).rejects.toThrow(NotFoundException);
    });

    it('getByDate：返回最新 done 任务的 B 列表与统计', async () => {
      runRepo.find.mockResolvedValue([makeRun()]);
      signalRepo.find.mockResolvedValue([
        { code: '000001', market: 'sz', name: '平安银行', value: '1' },
      ]);
      const res = await service.getByDate('2026-07-31');
      expect(res.found).toBe(2);
      expect(res.items).toEqual([{ code: '000001', market: 'sz', name: '平安银行' }]);
    });

    it('getDates：同一日期多次扫描只保留最新一条', async () => {
      runRepo.find.mockResolvedValue([
        makeRun({ id: 'run-new', queryDate: '2026-07-31' }),
        makeRun({
          id: 'run-old',
          queryDate: '2026-07-31',
          createdAt: new Date('2026-07-31T08:00:00Z'),
        }),
        makeRun({ id: 'run-prev', queryDate: '2026-07-30' }),
      ]);
      const dates = await service.getDates();
      expect(dates.map((d) => d.date)).toEqual(['2026-07-31', '2026-07-30']);
    });
  });
});
