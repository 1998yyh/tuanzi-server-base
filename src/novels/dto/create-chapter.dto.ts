import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateChapterDto {
  @ApiProperty({ example: '第一章 科学边界', description: '章节标题', maxLength: 255 })
  @IsString()
  @IsNotEmpty({ message: '章节标题不能为空' })
  @MaxLength(255)
  title: string;

  @ApiProperty({ example: '汪淼站在纳米材料研究所的落地窗前...', description: '章节内容' })
  @IsString()
  @IsNotEmpty({ message: '章节内容不能为空' })
  content: string;

  @ApiProperty({ example: 1, description: '章节序号' })
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  chapterOrder: number;
}

export class UpdateChapterDto {
  @ApiPropertyOptional({ example: '第一章 科学边界', description: '章节标题', maxLength: 255 })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ example: '汪淼站在纳米材料研究所的落地窗前...', description: '章节内容' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ example: 1, description: '章节序号' })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  chapterOrder?: number;
}

export class QueryChapterDto {
  @ApiPropertyOptional({ required: false, default: 1, description: '页码' })
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ required: false, default: 50, description: '每页数量' })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 50;
}