import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class QuotesQueryDto {
  @ApiProperty({ example: '600519,300750', description: '逗号分隔的六位 A 股代码，最多 50 个' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray({ message: 'codes 必须是逗号分隔的股票代码' })
  @ArrayMinSize(1, { message: '至少提供一个股票代码' })
  @ArrayMaxSize(50, { message: '单次最多查询 50 只股票' })
  @Matches(/^\d{6}$/, { each: true, message: '股票代码必须为六位数字' })
  codes: string[];
}

export class BarsQueryDto {
  @ApiProperty({ example: '600519', description: '六位 A 股代码' })
  @IsString()
  @Matches(/^\d{6}$/, { message: '股票代码必须为六位数字' })
  code: string;

  @ApiProperty({ enum: ['day', 'week', 'minute'], example: 'day', description: 'K 线周期' })
  @IsIn(['day', 'week', 'minute'], { message: 'period 必须为 day、week 或 minute' })
  period: 'day' | 'week' | 'minute';

  @ApiProperty({ enum: ['qfq', 'none', 'hfq'], example: 'qfq', description: '复权方式' })
  @IsIn(['qfq', 'none', 'hfq'], { message: 'adjustment 必须为 qfq、none 或 hfq' })
  adjustment: 'qfq' | 'none' | 'hfq';
}

export class SearchStocksQueryDto {
  @ApiProperty({ example: '茅台', description: '股票代码或名称关键字，最多 50 个字符' })
  @IsString()
  @MaxLength(50, { message: '搜索词最多 50 个字符' })
  q: string;
}
