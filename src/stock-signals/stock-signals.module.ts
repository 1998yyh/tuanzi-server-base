import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockSignalScanRun } from './entities/scan-run.entity';
import { StockSignal } from './entities/stock-signal.entity';
import { StockWatchlist } from './entities/watchlist.entity';
import { StockSignalsController } from './stock-signals.controller';
import { StockSignalsService } from './stock-signals.service';
import { SinaScannerService } from './sina-scanner.service';
import { WatchlistController } from './watchlist.controller';
import { WatchlistService } from './watchlist.service';
import { WatchlistCronService } from './watchlist-cron.service';

@Module({
  imports: [TypeOrmModule.forFeature([StockSignalScanRun, StockSignal, StockWatchlist])],
  controllers: [StockSignalsController, WatchlistController],
  providers: [StockSignalsService, SinaScannerService, WatchlistService, WatchlistCronService],
})
export class StockSignalsModule {}
