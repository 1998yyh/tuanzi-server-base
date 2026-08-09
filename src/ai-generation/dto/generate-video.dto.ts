import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { GenerationNodeRefDto } from './generate-image.dto';

export class GenerateVideoDto {
  @ApiProperty({
    example: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d::doubao-seedance-1-5-pro',
    description: '模型引用，格式 "channelId::modelName"',
  })
  @IsString()
  @Matches(/^[0-9a-fA-F-]{36}::.+$/, { message: 'modelRef 格式必须为 "channelId::modelName"' })
  modelRef: string;

  @ApiProperty({ example: '一只柴犬在月球上奔跑，电影感运镜', description: '生成提示词' })
  @IsString()
  @Length(1, 8000)
  prompt: string;

  @ApiProperty({
    required: false,
    example: '6',
    description: '时长（秒），1-20；Seedance 支持 -1 自动',
  })
  @IsString()
  @IsOptional()
  seconds?: string;

  @ApiProperty({
    required: false,
    example: '16:9',
    description: '尺寸/比例：auto / "16:9" / "1280x720"（Seedance 归一化为比例）',
  })
  @IsString()
  @IsOptional()
  size?: string;

  @ApiProperty({
    required: false,
    example: '720p',
    description: '清晰度：480p/720p/1080p 或 low/medium/high',
  })
  @IsString()
  @IsOptional()
  vquality?: string;

  @ApiProperty({
    required: false,
    example: 'true',
    description: '是否生成配音（"true"/"false"，Seedance 有效）',
  })
  @IsString()
  @IsOptional()
  generateAudio?: string;

  @ApiProperty({
    required: false,
    example: 'false',
    description: '是否加水印（"true"/"false"，Seedance 有效）',
  })
  @IsString()
  @IsOptional()
  watermark?: string;

  @ApiProperty({
    required: false,
    type: [String],
    description: '参考素材媒体 ID（图片≤9 / 视频≤3 / 音频≤3，仅 Seedance 支持音视频参考）',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(15)
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
