import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResearchWatch } from '../stock-research/research-watch.entity';
import { StockStrategiesModule } from '../stock-strategies/stock-strategies.module';
import { StockMarketModule } from '../stock-market/stock-market.module';
import { StockScreeningRun } from './screening-run.entity';
import { StockScreeningController } from './stock-screening.controller';
import { StockScreeningService } from './stock-screening.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([StockScreeningRun, ResearchWatch]),
    StockStrategiesModule,
    StockMarketModule,
  ],
  controllers: [StockScreeningController],
  providers: [StockScreeningService],
  exports: [StockScreeningService],
})
export class StockScreeningModule {}
