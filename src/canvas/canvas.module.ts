import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CanvasProject } from './canvas-project.entity';
import { CanvasController } from './canvas.controller';
import { CanvasService } from './canvas.service';
import { CanvasDocumentService } from './canvas-document.service';
import { CanvasOpsService } from './canvas-ops.service';

@Module({
  imports: [TypeOrmModule.forFeature([CanvasProject])],
  controllers: [CanvasController],
  providers: [CanvasService, CanvasDocumentService, CanvasOpsService],
  exports: [CanvasService, CanvasDocumentService, CanvasOpsService],
})
export class CanvasModule {}
