import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class CreateConversationDto {
  @ApiProperty({
    required: false,
    example: '股价分析咨询',
    description: '会话标题（不传则取首条用户消息前 30 字）',
  })
  @IsString()
  @Length(1, 255)
  @IsOptional()
  title?: string;
}
