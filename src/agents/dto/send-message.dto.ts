import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({
    example: '帮我分析苹果公司最新股价',
    description: '用户消息内容',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  content: string;
}
