import { ApiProperty } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { ResearchContext } from '../research-context';
export class CreateResearchDto {
  @ApiProperty({
    description: '当前用户启用的 Agent 编号',
    example: '11111111-1111-4111-8111-111111111111',
  })
  @IsUUID(undefined, { message: 'Agent 编号必须为UUID' })
  agentId: string;
  @ApiProperty({ description: '会话标题，可省略', example: '每日大盘复盘', required: false })
  @IsOptional()
  @IsString({ message: '标题必须为文字' })
  @Length(1, 100, { message: '标题为1到100字符' })
  title?: string;
  @ApiProperty({
    description: '研究上下文：general/market/stock/screen',
    type: 'object',
    additionalProperties: true,
    example: { kind: 'stock', date: '2026-09-10', code: '600519' },
  })
  @IsObject({ message: '上下文必须为对象' })
  context: ResearchContext;
}
export class CreateWatchDto {
  @ApiProperty({ description: '六位A股代码', example: '600519' })
  @Matches(/^\d{6}$/, { message: '股票代码为6位数字' })
  code: string;
  @ApiProperty({ description: '股票名称（用户提供的标签）', example: '贵州茅台' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: '股票名称必须为文字' })
  @Length(1, 50, { message: '股票名称为1到50字符' })
  name: string;
  @ApiProperty({ description: '观察理由', example: '关注指标信号延续', required: false })
  @IsOptional()
  @IsString({ message: '观察理由必须为文字' })
  @MaxLength(2000, { message: '观察理由最多2000字符' })
  reason?: string;
}
