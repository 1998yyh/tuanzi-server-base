import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class CreateScanDto {
  @ApiProperty({
    required: false,
    example: '2026-08-01',
    description: '信号日期（YYYY-MM-DD，北京时间），缺省为今天，不可为未来日期',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 必须为 YYYY-MM-DD 格式' })
  @IsOptional()
  date?: string;

  @ApiProperty({
    required: false,
    type: [String],
    example: ['600519', 'sz000001'],
    description: '指定主板股票代码（可带 sh/sz 前缀）；不传则全市场扫描',
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(500, { message: '单次最多指定 500 只' })
  @IsOptional()
  codes?: string[];

  @ApiProperty({ required: false, example: false, description: '强制刷新：忽略缓存重新抓取' })
  @IsBoolean()
  @IsOptional()
  refresh?: boolean;
}
