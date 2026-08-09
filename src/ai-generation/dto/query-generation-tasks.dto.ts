import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ModelCapability } from '../entities/ai-channel.entity';
import { GenerationTaskStatus } from '../entities/generation-task.entity';

export class QueryGenerationTasksDto {
  @ApiProperty({ required: false, example: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiProperty({ required: false, example: 20, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 20;

  @ApiProperty({ required: false, enum: ModelCapability, description: '按能力过滤' })
  @IsEnum(ModelCapability)
  @IsOptional()
  capability?: ModelCapability;

  @ApiProperty({ required: false, enum: GenerationTaskStatus, description: '按状态过滤' })
  @IsEnum(GenerationTaskStatus)
  @IsOptional()
  status?: GenerationTaskStatus;
}
