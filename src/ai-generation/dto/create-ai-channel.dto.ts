import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  Matches,
  IsNotIn,
  Min,
  Max,
  ArrayMaxSize,
  ArrayUnique,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { ApiFormat, ModelCapability } from '../entities/ai-channel.entity';

import { VideoModelConfig, VIDEO_FIELD_PATTERN, RESERVED_VIDEO_FIELDS } from '../video-presets';

export class VideoFieldsDto {
  @ApiProperty({ required: false, description: 'images 对应的请求字段名' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(VIDEO_FIELD_PATTERN)
  @IsNotIn(RESERVED_VIDEO_FIELDS)
  images?: string;
  @ApiProperty({ required: false, description: 'firstFrame 对应的请求字段名' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(VIDEO_FIELD_PATTERN)
  @IsNotIn(RESERVED_VIDEO_FIELDS)
  firstFrame?: string;
  @ApiProperty({ required: false, description: 'lastFrame 对应的请求字段名' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(VIDEO_FIELD_PATTERN)
  @IsNotIn(RESERVED_VIDEO_FIELDS)
  lastFrame?: string;
  @ApiProperty({ required: false, description: 'audio 对应的请求字段名' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(VIDEO_FIELD_PATTERN)
  @IsNotIn(RESERVED_VIDEO_FIELDS)
  audio?: string;
  @ApiProperty({ required: false, description: 'seconds 对应的请求字段名' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(VIDEO_FIELD_PATTERN)
  @IsNotIn(RESERVED_VIDEO_FIELDS)
  seconds?: string;
  @ApiProperty({ required: false, description: 'resolution 对应的请求字段名' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(VIDEO_FIELD_PATTERN)
  @IsNotIn(RESERVED_VIDEO_FIELDS)
  resolution?: string;
  @ApiProperty({ required: false, description: 'aspectRatio 对应的请求字段名' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(VIDEO_FIELD_PATTERN)
  @IsNotIn(RESERVED_VIDEO_FIELDS)
  aspectRatio?: string;
}

export class VideoModelConfigDto implements VideoModelConfig {
  @ApiProperty({ enum: ['text', 'image', 'first_last', 'lipsync'], description: '视频素材模板' })
  @IsIn(['text', 'image', 'first_last', 'lipsync'])
  template: VideoModelConfig['template'];
  @ApiProperty({ enum: ['json', 'multipart'], description: '视频创建请求格式' })
  @IsIn(['json', 'multipart'])
  requestFormat: VideoModelConfig['requestFormat'];
  @ApiProperty({ required: false, type: VideoFieldsDto, description: '扁平字段映射' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => VideoFieldsDto)
  fields?: VideoFieldsDto;
  @ApiProperty({ required: false, description: 'minImages 约束' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(20)
  minImages?: number;
  @ApiProperty({ required: false, description: 'maxImages 约束' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(20)
  maxImages?: number;
  @ApiProperty({ required: false, description: 'maxSeconds 约束' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(600)
  maxSeconds?: number;
  @ApiProperty({ required: false, description: 'fixedSeconds 约束' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(600)
  fixedSeconds?: number;
  @ApiProperty({
    required: false,
    type: [String],
    description: '支持的清晰度；空数组表示不发送清晰度',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 32, { each: true })
  resolutions?: string[];
  @ApiProperty({ required: false, description: '固定输出清晰度' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 32)
  fixedResolution?: string;
}

export class ChannelModelDto {
  @ApiProperty({ example: 'gpt-image-2', description: '模型名称（渠道侧标识）' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({ enum: ModelCapability, example: 'image', description: '模型用途' })
  @IsEnum(ModelCapability)
  capability: ModelCapability;

  @ApiProperty({
    required: false,
    description: '自定义调用脚本（v1 服务端不支持执行，仅保留字段）',
  })
  @IsString()
  @IsOptional()
  script?: string;

  @ApiProperty({
    required: false,
    type: VideoModelConfigDto,
    description: '视频模型调用规则，仅视频用途可配置',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => VideoModelConfigDto)
  videoConfig?: VideoModelConfigDto;
}

export class CreateAiChannelDto {
  @ApiProperty({ example: 'OpenAI 官方', description: '渠道名称' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({ enum: ApiFormat, example: 'openai', description: 'API 格式' })
  @IsEnum(ApiFormat)
  apiFormat: ApiFormat;

  @ApiProperty({ example: 'https://api.openai.com', description: '接口地址（自动补 /v1）' })
  @IsUrl({ require_tld: false }, { message: '必须提供合法的 baseUrl' })
  baseUrl: string;

  @ApiProperty({ example: 'sk-xxx', description: 'API Key（加密存储，响应中只回脱敏值）' })
  @IsString()
  @Length(1, 500)
  apiKey: string;

  @ApiProperty({ type: [ChannelModelDto], description: '模型清单（至少一个）' })
  @IsArray()
  @ArrayMinSize(1, { message: '至少配置一个模型' })
  @ValidateNested({ each: true })
  @Type(() => ChannelModelDto)
  models: ChannelModelDto[];

  @ApiProperty({ required: false, description: '是否启用（缺省 true）' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
