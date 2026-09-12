import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockMarketModule } from '../stock-market';
import { StockAlertEvent } from './stock-alert-event.entity';
import { StockAlert } from './stock-alert.entity';
import { StockAlertsController } from './stock-alerts.controller';
import { StockAlertsService } from './stock-alerts.service';

@Module({
  imports: [TypeOrmModule.forFeature([StockAlert, StockAlertEvent]), StockMarketModule],
  controllers: [StockAlertsController],
  providers: [StockAlertsService],
  exports: [StockAlertsService],
})
export class StockAlertsModule {}
