import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateAgentDto } from './create-agent.dto';

/** 部分更新；channelId/modelName 传其一时按合并后的组合校验 */
export class UpdateAgentDto extends PartialType(CreateAgentDto) {
  @ApiProperty({
    required: false,
    example: false,
    description: '是否启用（false 即软删除，可再传 true 重新激活）',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
