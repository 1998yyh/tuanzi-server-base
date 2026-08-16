import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class GenerationNodeRefDto {
  @ApiProperty({ description: '画布项目 ID' })
  @IsUUID()
  projectId: string;

  @ApiProperty({ description: '画布节点 ID' })
  @IsString()
  @Length(1, 100)
  nodeId: string;
}

export class GenerateImageDto {
  @ApiProperty({
    example: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d::gpt-image-2',
    description: '模型引用，格式 "channelId::modelName"',
  })
  @IsString()
  @Matches(/^[0-9a-fA-F-]{36}::.+$/, { message: 'modelRef 格式必须为 "channelId::modelName"' })
  modelRef: string;

  @ApiProperty({ example: '一只在月球上喝茶的柴犬，电影感', description: '生成提示词' })
  @IsString()
  @Length(1, 8000)
  prompt: string;

  @ApiProperty({ required: false, description: '系统提示词（拼接到 prompt 前）' })
  @IsString()
  @Length(0, 4000)
  @IsOptional()
  systemPrompt?: string;

  @ApiProperty({ required: false, example: 1, description: '生成数量（1-15）', default: 1 })
  @IsInt()
  @Min(1)
  @Max(15)
  @Type(() => Number)
  @IsOptional()
  count?: number = 1;

  @ApiProperty({
    required: false,
    example: 'medium',
    description: '质量档位：low/medium/high/standard/hd/1k/2k/4k',
  })
  @IsString()
  @IsOptional()
  quality?: string;

  @ApiProperty({
    required: false,
    example: '16:9',
    description: '尺寸：auto / 比例 "16:9" / 像素 "2048x1152"',
    default: 'auto',
  })
  @IsString()
  @IsOptional()
  size?: string;

  @ApiProperty({
    required: false,
    example: 'transparent',
    description: '背景：仅 transparent 会被转发',
  })
  @IsString()
  @IsOptional()
  background?: string;

  @ApiProperty({
    required: false,
    type: [String],
    description: '参考图媒体 ID 列表（传入即为图生图/参考图编辑）',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(10)
  @IsOptional()
  referenceMediaIds?: string[];

  @ApiProperty({
    required: false,
    type: GenerationNodeRefDto,
    description: '生成完成后回填的画布节点',
  })
  @ValidateNested()
  @Type(() => GenerationNodeRefDto)
  @IsOptional()
  nodeRef?: GenerationNodeRefDto;
}
