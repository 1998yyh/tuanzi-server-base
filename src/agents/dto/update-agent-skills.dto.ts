import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class UpdateAgentSkillsDto {
  @ApiProperty({
    type: [String],
    example: ['b3b7c6e2-....'],
    description: '关联的 Skill ID 列表（整体替换，传空数组清空）',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  skillIds: string[];
}
