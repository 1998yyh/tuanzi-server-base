import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockSignalScanRun } from './entities/scan-run.entity';
import { StockSignal } from './entities/stock-signal.entity';
import { StockSignalsController } from './stock-signals.controller';
import { StockSignalsService } from './stock-signals.service';
import { SinaScannerService } from './sina-scanner.service';

@Module({
  imports: [TypeOrmModule.forFeature([StockSignalScanRun, StockSignal])],
  controllers: [StockSignalsController],
  providers: [StockSignalsService, SinaScannerService],
})
export class StockSignalsModule {}
