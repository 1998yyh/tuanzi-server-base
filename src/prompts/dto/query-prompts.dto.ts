import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryPromptsDto {
  @ApiProperty({ required: false, description: '关键词（标题/内容/描述/标签模糊匹配）' })
  @IsString()
  @IsOptional()
  keyword?: string;

  @ApiProperty({ required: false, description: '标签过滤（逗号分隔多个）' })
  @IsString()
  @IsOptional()
  tag?: string;

  @ApiProperty({ required: false, example: 'all', description: '分类（源名称），all 表示全部' })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiProperty({ required: false, example: 1, description: '页码' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiProperty({ required: false, example: 20, description: '每页数量（最大 100）' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize: number = 20;
}
