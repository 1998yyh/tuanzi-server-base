import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsObject, IsString, Length, Max, Min } from 'class-validator';
import type { StrategyDefinition } from '../strategy-definition';
export class CreateStrategyDto {
  @ApiProperty({
    example: '低位金叉观察',
    description: '个人策略名称，去除首尾空白，已删除名称仍保留',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: '策略名称必须为字符串' })
  @Length(1, 80, { message: '策略名称必须为 1 到 80 个字符' })
  name: string;

  @ApiProperty({
    description: '完整策略定义，支持 MA/MACD/KDJ/RSI/BOLL，参数按指标顺序；详情见接入文档',
    type: 'object',
    additionalProperties: true,
    example: {
      period: 'day',
      adjustment: 'qfq',
      scope: 'watchlist',
      match: 'all',
      conditions: [{ indicator: 'MACD', parameters: [12, 26, 9] }],
    },
  })
  @IsObject({ message: '策略定义必须为对象' })
  definition: StrategyDefinition;
}
export class UpdateStrategyDto extends CreateStrategyDto {
  @ApiProperty({ example: 1, description: '读取策略时取得的版本号，用于防止并发覆盖' })
  @IsInt({ message: '版本号必须为整数' })
  @Min(1, { message: '版本号至少为 1' })
  @Max(2147483646, { message: '版本号超出范围' })
  version: number;
}
export class StrategyPageDto {
  @ApiProperty({ required: false, default: 1, example: 1, description: '页码，从 1 开始' })
  @Type(() => Number)
  @IsInt({ message: '页码必须为整数' })
  @Min(1, { message: '页码至少为 1' })
  @Max(1000000, { message: '页码超出范围' })
  page = 1;

  @ApiProperty({ required: false, default: 20, example: 20, description: '每页条数，最多 100' })
  @Type(() => Number)
  @IsInt({ message: '每页条数必须为整数' })
  @Min(1, { message: '每页条数至少为 1' })
  @Max(100, { message: '每页条数最多为 100' })
  limit = 20;
}
export class DeleteStrategyDto {
  @ApiProperty({ example: 1, description: '当前策略版本号；通过查询参数传递' })
  @Type(() => Number)
  @IsInt({ message: '版本号必须为整数' })
  @Min(1, { message: '版本号至少为 1' })
  @Max(2147483646, { message: '版本号超出范围' })
  version: number;
}
