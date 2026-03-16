import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsDateString, IsString, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { DailyReportType } from '../daily-reports.entity';

export class CreateDailyReportDto {
  @ApiProperty({ enum: DailyReportType, example: 'ai', description: '日报类型' })
  @IsEnum(DailyReportType)
  @IsNotEmpty()
  type: DailyReportType;

  @ApiProperty({ example: 'AI情报早报 | 2026-03-16', description: '日报标题' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: '2026-03-16', description: '日报日期' })
  @IsDateString()
  @IsNotEmpty()
  date: string;

  @ApiProperty({ example: '# 标题\n内容...', description: 'Markdown 内容' })
  @IsString()
  @IsNotEmpty()
  content: string;
}

export class QueryDailyReportDto {
  @ApiProperty({ enum: DailyReportType, required: false, description: '日报类型筛选' })
  @IsEnum(DailyReportType)
  @IsOptional()
  type?: DailyReportType;

  @ApiProperty({ required: false, example: '2026-03-16', description: '指定日期' })
  @IsDateString()
  @IsOptional()
  date?: string;

  @ApiProperty({ required: false, default: 1, description: '页码' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @IsOptional()
  page?: number = 1;

  @ApiProperty({ required: false, default: 10, description: '每页数量' })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @IsOptional()
  limit?: number = 10;
}