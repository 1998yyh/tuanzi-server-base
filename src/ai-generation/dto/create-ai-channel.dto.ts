import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  ValidateNested,
} from 'class-validator';
import { ApiFormat, ModelCapability } from '../entities/ai-channel.entity';

export class ChannelModelDto {
  @ApiProperty({ example: 'gpt-image-2', description: '模型名称（渠道侧标识）' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({ enum: ModelCapability, example: 'image', description: '模型能力' })
  @IsEnum(ModelCapability)
  capability: ModelCapability;

  @ApiProperty({
    required: false,
    description: '自定义调用脚本（v1 服务端不支持执行，仅保留字段）',
  })
  @IsString()
  @IsOptional()
  script?: string;
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
