import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NovelsController } from './novels.controller';
import { NovelsAdminController } from './novels-admin.controller';
import { NovelsService } from './novels.service';
import { Novel } from './novel.entity';
import { Chapter } from './chapter.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Novel, Chapter])],
  controllers: [NovelsController, NovelsAdminController],
  providers: [NovelsService],
  exports: [NovelsService],
})
export class NovelsModule {}