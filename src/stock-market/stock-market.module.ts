import { Module } from '@nestjs/common';
import { StockMarketController } from './stock-market.controller';
import { StockMarketService } from './stock-market.service';

@Module({
  controllers: [StockMarketController],
  providers: [StockMarketService],
  exports: [StockMarketService],
})
export class StockMarketModule {}
