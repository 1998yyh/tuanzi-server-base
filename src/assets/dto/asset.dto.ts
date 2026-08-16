import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { AssetKind } from '../asset.entity';

export class CreateAssetDto {
  @ApiProperty({ enum: AssetKind, example: 'text', description: '素材类型' })
  @IsEnum(AssetKind)
  kind: AssetKind;

  @ApiProperty({ example: '电影感人像提示词', description: '素材标题' })
  @IsString()
  @Length(1, 200)
  title: string;

  @ApiProperty({ required: false, description: '文本内容（kind=text 必填）' })
  @IsString()
  @Length(0, 50000)
  @IsOptional()
  textContent?: string;

  @ApiProperty({ required: false, description: '媒体文件 ID（kind=image/video 必填）' })
  @IsUUID('4')
  @IsOptional()
  mediaId?: string;

  @ApiProperty({ required: false, type: [String], description: '标签' })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  @IsOptional()
  tags?: string[];

  @ApiProperty({ required: false, description: '来源说明' })
  @IsString()
  @Length(0, 200)
  @IsOptional()
  source?: string;

  @ApiProperty({ required: false, description: '备注' })
  @IsString()
  @Length(0, 500)
  @IsOptional()
  note?: string;
}

export class QueryAssetsDto {
  @ApiProperty({ required: false, enum: AssetKind, description: '按类型过滤' })
  @IsEnum(AssetKind)
  @IsOptional()
  kind?: AssetKind;

  @ApiProperty({ required: false, description: '关键词（标题/内容/标签模糊匹配）' })
  @IsString()
  @IsOptional()
  keyword?: string;

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
  limit: number = 20;
}
