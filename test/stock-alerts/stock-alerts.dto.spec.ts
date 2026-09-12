import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateStockAlertDto,
  QueryStockAlertsDto,
  normalizeAlertParameters,
} from 'src/stock-alerts/dto/stock-alert.dto';

describe('股票提醒 DTO', () => {
  it('列表分页具有一致默认值', async () => {
    const dto = plainToInstance(QueryStockAlertsDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto).toMatchObject({ page: 1, limit: 20 });
  });

  it('拒绝未知字段、非法代码、非有限阈值和不支持的操作符', async () => {
    const invalid = [
      { code: 'bad', field: 'price', operator: 'gte', threshold: 10 },
      { code: '600000', field: 'volume', operator: 'gte', threshold: 10 },
      { code: '600000', field: 'price', operator: 'eq', threshold: 10 },
      { code: '600000', field: 'price', operator: 'gte', threshold: Number.POSITIVE_INFINITY },
    ];
    for (const input of invalid)
      expect(await validate(plainToInstance(CreateStockAlertDto, input))).not.toHaveLength(0);
  });

  it('补齐指标默认参数并拒绝错误参数', async () => {
    expect(normalizeAlertParameters('MA')).toEqual([20]);
    expect(normalizeAlertParameters('MACD')).toEqual([12, 26, 9]);
    expect(normalizeAlertParameters('KDJ')).toEqual([9, 3, 3]);
    expect(normalizeAlertParameters('RSI')).toEqual([12]);
    expect(normalizeAlertParameters('BOLL')).toEqual([20, 2]);
    const dto = plainToInstance(CreateStockAlertDto, {
      code: '600000',
      field: 'MACD',
      operator: 'gte',
      threshold: 0,
      parameters: [12, 9],
    });
    expect(await validate(dto)).not.toHaveLength(0);
    expect(() => normalizeAlertParameters('MACD', [26, 12, 9])).toThrow();
  });
});
