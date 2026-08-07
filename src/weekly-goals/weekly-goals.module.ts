import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WeeklyGoalsController } from './weekly-goals.controller';
import { WeeklyGoalsService } from './weekly-goals.service';
import { WeeklyGoal } from './weekly-goals.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WeeklyGoal])],
  controllers: [WeeklyGoalsController],
  providers: [WeeklyGoalsService],
  exports: [WeeklyGoalsService],
})
export class WeeklyGoalsModule {}
