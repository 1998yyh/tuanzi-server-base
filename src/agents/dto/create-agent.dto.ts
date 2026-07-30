import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProviderType } from '../entities/agent-config.entity';

export class CreateAgentDto {
  @ApiProperty({ example: '客服助手', description: 'Agent 名称' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({ required: false, example: '处理售前咨询', description: 'Agent 描述' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    enum: ProviderType,
    example: 'anthropic',
    description: 'LLM 供应商',
  })
  @IsEnum(ProviderType)
  provider: ProviderType;

  @ApiProperty({ example: 'claude-opus-4-8', description: '模型名称' })
  @IsString()
  @IsNotEmpty()
  model: string;

  @ApiProperty({
    example: 'sk-ant-xxxx',
    description: 'LLM API Key（加密存储，响应中永不回显明文）',
  })
  @IsString()
  @IsNotEmpty()
  apiKey: string;

  @ApiProperty({
    required: false,
    example: 'https://gateway.example.com/v1',
    description: '自定义 API 请求地址（中转网关/私有部署用），不传走 SDK 默认地址',
  })
  // require_tld: false 放行 localhost / 内网 IP 这类无顶级域的地址
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @IsOptional()
  baseUrl?: string | null;

  @ApiProperty({ required: false, example: '你是一个专业客服...', description: '系统提示词' })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiProperty({
    required: false,
    default: 4096,
    example: 4096,
    description: '单次生成最大 token 数',
  })
  @IsInt()
  @Min(1)
  @Max(200000)
  @Type(() => Number)
  @IsOptional()
  maxTokens?: number = 4096;

  @ApiProperty({
    required: false,
    default: 10,
    example: 10,
    description: 'tool loop 最大轮次（防止无限循环）',
  })
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  @IsOptional()
  maxIterations?: number = 10;

  @ApiProperty({
    required: false,
    type: [String],
    example: ['web_search'],
    description: '启用的内置工具名列表',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  enabledTools?: string[];
}
