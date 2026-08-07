import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { WeeklyGoalStatus } from '../weekly-goals.entity';

export class CreateWeeklyGoalDto {
  @ApiProperty({ example: '读完《纳瓦尔宝典》', description: '周目标标题' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiProperty({ required: false, example: '每天睡前看 30 分钟', description: '备注（可选）' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

export class QueryWeeklyGoalDto {
  @ApiProperty({
    enum: WeeklyGoalStatus,
    required: false,
    default: WeeklyGoalStatus.ACTIVE,
    description: '状态筛选：active 进行中 / completed 已完成（归档）',
  })
  @IsEnum(WeeklyGoalStatus)
  @IsOptional()
  status?: WeeklyGoalStatus = WeeklyGoalStatus.ACTIVE;
}
