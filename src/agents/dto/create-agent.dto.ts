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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProviderType } from '../entities/agent-config.entity';

export class McpServerDto {
  @ApiProperty({ example: '文件系统', description: 'MCP Server 名称' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    enum: ['stdio', 'sse'],
    example: 'sse',
    description:
      '连接方式：stdio 在服务端执行子进程（仅管理员可配置），sse 连接已部署的 MCP Server',
  })
  @IsEnum(['stdio', 'sse'])
  transport: 'stdio' | 'sse';

  @ApiProperty({
    required: false,
    example: 'npx @modelcontextprotocol/server-filesystem /tmp',
    description: 'stdio 模式必填：启动命令',
  })
  @ValidateIf((o: McpServerDto) => o.transport === 'stdio')
  @IsString()
  @IsNotEmpty({ message: 'stdio 模式必须提供 command' })
  command?: string;

  @ApiProperty({
    required: false,
    example: 'https://mcp.example.com/sse',
    description: 'sse 模式必填：服务端 URL',
  })
  @ValidateIf((o: McpServerDto) => o.transport === 'sse')
  @IsUrl({ require_tld: false }, { message: 'sse 模式必须提供合法的 url' })
  url?: string;
}

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
    description: 'LLM 供应商（deepseek 暂未支持）',
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

  @ApiProperty({
    required: false,
    type: [McpServerDto],
    description: '挂载的 MCP Server 列表',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => McpServerDto)
  @IsOptional()
  mcpServers?: McpServerDto[];
}
