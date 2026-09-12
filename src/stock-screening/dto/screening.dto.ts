import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateScreeningRunDto {
  @ApiProperty({ example: 'macd-cross', description: '固定模板 ID 或当前用户保存的策略 UUID' })
  @IsString({ message: 'strategyId 必须为字符串' })
  strategyId: string;

  @ApiProperty({
    required: false,
    type: [String],
    example: ['600519', '300750'],
    description: '可选指定代码；缺省按策略 scope 取观察池或全市场，最多 500 只',
  })
  @IsOptional()
  @IsArray({ message: 'codes 必须为数组' })
  @ArrayMinSize(1, { message: '至少提供一个股票代码' })
  @ArrayMaxSize(500, { message: '单次最多指定 500 只股票' })
  @Matches(/^\d{6}$/, { each: true, message: '股票代码必须为六位数字' })
  codes?: string[];
}

export class ScreeningRunsQueryDto {
  @ApiProperty({ required: false, default: 1, description: '页码' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;
  @ApiProperty({ required: false, default: 20, description: '每页条数，最多 100' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
