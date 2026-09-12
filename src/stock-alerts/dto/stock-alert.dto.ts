import { BadRequestException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';
import type { AlertField, AlertOperator } from '../alert-evaluator';

export class CreateStockAlertDto {
  @ApiProperty({ example: '600000', description: '六位 A 股代码' })
  @Matches(/^\d{6}$/, { message: '股票代码必须为六位数字' })
  code: string;

  @ApiProperty({
    enum: ['price', 'change', 'MA', 'MACD', 'KDJ', 'RSI', 'BOLL'],
    example: 'price',
    description: '监控字段',
  })
  @IsIn(['price', 'change', 'MA', 'MACD', 'KDJ', 'RSI', 'BOLL'], {
    message: '监控字段不受支持',
  })
  field: AlertField;

  @ApiProperty({
    enum: ['gte', 'lte'],
    example: 'gte',
    description: 'gte 为上穿/金叉，lte 为下穿/死叉',
  })
  @IsIn(['gte', 'lte'], { message: '操作符仅支持 gte 或 lte' })
  operator: AlertOperator;

  @ApiProperty({
    example: 10.5,
    description: '价格、涨跌幅或 RSI 阈值；交叉类指标中保留但不参与计算',
  })
  @IsNumber({ allowInfinity: false, allowNaN: false }, { message: '阈值必须为有限数字' })
  threshold: number;

  @ApiProperty({
    required: false,
    type: [Number],
    example: [12, 26, 9],
    description: '指标参数；不传时使用各指标默认值',
  })
  @IsOptional()
  @IsArray({ message: '指标参数必须为数组' })
  @ValidateBy({
    name: 'alertParameters',
    validator: {
      validate: (value: unknown, args) => {
        if (value === undefined) return true;
        if (!Array.isArray(value) || !args) return false;
        try {
          normalizeAlertParameters((args.object as CreateStockAlertDto).field, value);
          return true;
        } catch {
          return false;
        }
      },
      defaultMessage: () => '指标参数数量、顺序或范围无效',
    },
  })
  parameters?: number[];
}

const defaults: Partial<Record<AlertField, number[]>> = {
  MA: [20],
  MACD: [12, 26, 9],
  KDJ: [9, 3, 3],
  RSI: [12],
  BOLL: [20, 2],
};

export function normalizeAlertParameters(field: AlertField, input?: number[]): number[] | null {
  if (field === 'price' || field === 'change') {
    if (input?.length) throw new BadRequestException('价格和涨跌幅提醒不接受指标参数');
    return null;
  }
  const values = input ?? defaults[field];
  if (!values || !values.every(Number.isFinite)) throw new BadRequestException('指标参数无效');
  const integer = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  const valid =
    (field === 'MA' && values.length === 1 && integer(values[0], 2, 250)) ||
    (field === 'MACD' &&
      values.length === 3 &&
      integer(values[0], 2, 100) &&
      integer(values[1], 3, 250) &&
      values[0] < values[1] &&
      integer(values[2], 2, 100)) ||
    (field === 'KDJ' &&
      values.length === 3 &&
      integer(values[0], 2, 250) &&
      integer(values[1], 1, 20) &&
      integer(values[2], 1, 20)) ||
    (field === 'RSI' && values.length === 1 && integer(values[0], 2, 250)) ||
    (field === 'BOLL' &&
      values.length === 2 &&
      integer(values[0], 2, 250) &&
      values[1] > 0 &&
      values[1] <= 10);
  if (!valid) throw new BadRequestException('指标参数数量、顺序或范围无效');
  return [...values];
}

export class UpdateStockAlertDto {
  @ApiProperty({ example: true, description: '是否启用提醒' })
  @IsBoolean({ message: 'enabled 必须为布尔值' })
  enabled: boolean;
}

export class QueryStockAlertsDto {
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
