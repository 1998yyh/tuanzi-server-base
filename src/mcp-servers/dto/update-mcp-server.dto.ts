import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
} from 'class-validator';
import { McpServerType } from '../mcp-server.entity';

/**
 * 部分更新。所有字段可选。
 *
 * 注意：不复用 CreateMcpServerDto 的 PartialType——PATCH 请求通常不带 type，
 * CreateDto 里依赖 type 的 ValidateIf 门控在 type 缺省时会整体失效，导致
 * command/args/env/headers/url 全部绕过校验。这里为 update 显式声明与 type
 * 解耦的字段校验：每个字段独立 @IsOptional + 类型校验。
 *
 * env/headers 不传则保持原值，传 null 语义不支持（清空传 {}）。
 */
export class UpdateMcpServerDto {
  @ApiProperty({ required: false, example: 'web-search', description: '全局唯一名称' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiProperty({
    required: false,
    enum: McpServerType,
    example: 'sse',
    description: '连接类型：stdio 在服务端执行子进程（仅管理员可配置）',
  })
  @IsOptional()
  @IsEnum(McpServerType)
  type?: McpServerType;

  @ApiProperty({ required: false, example: 'npx', description: 'stdio 类型：可执行命令' })
  @IsOptional()
  @IsString()
  command?: string;

  @ApiProperty({
    required: false,
    example: ['-y', '@modelcontextprotocol/server-filesystem'],
    description: 'stdio 类型：命令参数数组',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  args?: string[];

  @ApiProperty({
    required: false,
    example: { API_KEY: 'xxx' },
    description: 'stdio 类型：环境变量（加密存储，响应中不回显）',
  })
  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  @ApiProperty({
    required: false,
    example: 'https://mcp.example.com/sse',
    description: 'sse / streamable-http 类型：连接地址',
  })
  @IsOptional()
  @IsUrl({ require_tld: false }, { message: '必须提供合法的 url' })
  url?: string;

  @ApiProperty({
    required: false,
    example: { Authorization: 'Bearer xxx' },
    description: 'sse / streamable-http 类型：请求头（加密存储，响应中不回显）',
  })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiProperty({
    required: false,
    example: '联网搜索工具',
    description: '描述（展示在 Agent 配置界面）',
  })
  @IsOptional()
  @IsString()
  @Length(0, 255)
  description?: string;

  @ApiProperty({
    required: false,
    example: false,
    description: '停用后不可被 Agent 关联/调用（可再传 true 重新启用）',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
