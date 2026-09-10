import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { StockSignalsModule } from 'src/stock-signals/stock-signals.module';

describe('观察池路由注册回归', () => {
  it('股票模块必须包含前端调用的 stock-watchlist 控制器', () => {
    const controllers: Type<unknown>[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      StockSignalsModule,
    );
    const paths = controllers.map((controller) => Reflect.getMetadata(PATH_METADATA, controller));

    expect(paths).toContain('stock-watchlist');
  });
});
