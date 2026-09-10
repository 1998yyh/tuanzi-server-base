import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class AddWatchlistItemDto {
  @ApiProperty({ example: '600519', description: '6 位沪深主板股票代码' })
  @IsString()
  code: string;

  @ApiProperty({
    required: false,
    enum: ['sh', 'sz'],
    description: '市场；缺省按代码段推断（6 开头 sh，其余 sz）',
  })
  @IsIn(['sh', 'sz'])
  @IsOptional()
  market?: 'sh' | 'sz';

  @ApiProperty({ required: false, example: '贵州茅台', description: '股票名称；缺省取内置清单' })
  @IsString()
  @MaxLength(50)
  @IsOptional()
  name?: string;

  @ApiProperty({ example: '2026-08-21', description: '入池依据的 B 信号日期（YYYY-MM-DD）' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'entrySignalDate 必须为 YYYY-MM-DD 格式' })
  entrySignalDate: string;
}

export class AddWatchlistItemsDto {
  @ApiProperty({ type: [AddWatchlistItemDto], description: '入池条目（单用户池子上限 100 只）' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100, { message: '单次最多提交 100 条' })
  @ValidateNested({ each: true })
  @Type(() => AddWatchlistItemDto)
  items: AddWatchlistItemDto[];
}
