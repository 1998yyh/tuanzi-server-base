import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';
import { GenerationNodeRefDto } from './generate-image.dto';

export class GenerateAudioDto {
  @ApiProperty({
    example: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d::gpt-4o-mini-tts',
    description: '模型引用，格式 "channelId::modelName"',
  })
  @IsString()
  @Matches(/^[0-9a-fA-F-]{36}::.+$/, { message: 'modelRef 格式必须为 "channelId::modelName"' })
  modelRef: string;

  @ApiProperty({ example: '大家好，欢迎来到我的无限画布。', description: '要合成语音的文本' })
  @IsString()
  @Length(1, 8000)
  prompt: string;

  @ApiProperty({
    required: false,
    example: 'alloy',
    description: '音色：alloy/ash/ballad/coral/echo/fable/nova/onyx/sage/shimmer/verse/marin/cedar',
  })
  @IsString()
  @IsOptional()
  voice?: string;

  @ApiProperty({
    required: false,
    example: 'mp3',
    description: '音频格式：mp3/wav/opus/aac/flac/pcm',
  })
  @IsString()
  @IsOptional()
  format?: string;

  @ApiProperty({ required: false, example: '1', description: '语速（0.25-4）' })
  @IsString()
  @IsOptional()
  speed?: string;

  @ApiProperty({ required: false, description: '附加指令（语气/情绪等，模型支持时生效）' })
  @IsString()
  @Length(0, 2000)
  @IsOptional()
  instructions?: string;

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
