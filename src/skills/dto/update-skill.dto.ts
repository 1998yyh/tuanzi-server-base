import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateSkillDto } from './create-skill.dto';

export class UpdateSkillDto extends PartialType(CreateSkillDto) {
  @ApiProperty({ required: false, example: false, description: '停用后不可被 Agent 关联/调用' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
