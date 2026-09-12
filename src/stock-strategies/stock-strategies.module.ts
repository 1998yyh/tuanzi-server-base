import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockStrategy } from './stock-strategy.entity';
import { StockStrategiesController } from './stock-strategies.controller';
import { StockStrategiesService } from './stock-strategies.service';
@Module({
  imports: [TypeOrmModule.forFeature([StockStrategy])],
  controllers: [StockStrategiesController],
  providers: [StockStrategiesService],
  exports: [StockStrategiesService],
})
export class StockStrategiesModule {}
