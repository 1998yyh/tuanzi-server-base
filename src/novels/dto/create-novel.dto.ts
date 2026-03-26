import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsEnum,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { NovelStatus } from '../novel.entity';

export class CreateNovelDto {
  @ApiProperty({ example: '三体', description: '书名', maxLength: 255 })
  @IsString()
  @IsNotEmpty({ message: '书名不能为空' })
  @MaxLength(255)
  title: string;

  @ApiProperty({ example: '刘慈欣', description: '作者', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: '作者不能为空' })
  @MaxLength(100)
  author: string;

  @ApiPropertyOptional({ example: '地球文明向宇宙发出的第一声啼鸣...', description: '简介' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'https://example.com/cover.jpg', description: '封面图片URL', maxLength: 500 })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  coverUrl?: string;

  @ApiPropertyOptional({ enum: NovelStatus, default: NovelStatus.ONGOING, description: '状态: 0-连载中, 1-已完结' })
  @IsEnum(NovelStatus)
  @IsOptional()
  status?: NovelStatus;
}

export class UpdateNovelDto {
  @ApiPropertyOptional({ example: '三体', description: '书名', maxLength: 255 })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ example: '刘慈欣', description: '作者', maxLength: 100 })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  author?: string;

  @ApiPropertyOptional({ example: '地球文明向宇宙发出的第一声啼鸣...', description: '简介' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'https://example.com/cover.jpg', description: '封面图片URL', maxLength: 500 })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  coverUrl?: string;

  @ApiPropertyOptional({ enum: NovelStatus, description: '状态: 0-连载中, 1-已完结' })
  @IsEnum(NovelStatus)
  @IsOptional()
  status?: NovelStatus;
}

export class QueryNovelDto {
  @ApiPropertyOptional({ required: false, default: 1, description: '页码' })
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ required: false, default: 10, description: '每页数量' })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 10;

  @ApiPropertyOptional({ enum: NovelStatus, required: false, description: '状态筛选' })
  @IsEnum(NovelStatus)
  @IsOptional()
  status?: NovelStatus;
}