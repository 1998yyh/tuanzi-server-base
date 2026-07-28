import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateSkillDto } from './create-skill.dto';

/** 所有字段可选；mcpServerIds 传则整体替换关联，不传保持原值 */
export class UpdateSkillDto extends PartialType(CreateSkillDto) {
  @ApiProperty({ required: false, example: true, description: '是否启用（停用后不可被关联/执行）' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
