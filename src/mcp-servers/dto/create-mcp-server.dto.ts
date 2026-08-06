import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  ValidateIf,
} from 'class-validator';
import { McpServerType } from '../mcp-server.entity';

export class CreateMcpServerDto {
  @ApiProperty({ example: 'web-search', description: '全局唯一名称' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({
    enum: McpServerType,
    example: 'sse',
    description: '连接类型：stdio 在服务端执行子进程（仅管理员可创建）',
  })
  @IsEnum(McpServerType)
  type: McpServerType;

  @ApiProperty({ required: false, example: 'npx', description: 'stdio 类型必填：可执行命令' })
  @ValidateIf((o: CreateMcpServerDto) => o.type === McpServerType.STDIO)
  @IsString()
  @IsNotEmpty({ message: 'stdio 类型必须提供 command' })
  command?: string;

  @ApiProperty({
    required: false,
    example: ['-y', '@modelcontextprotocol/server-filesystem'],
    description: 'stdio 类型可选：命令参数数组',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  args?: string[];

  @ApiProperty({
    required: false,
    example: { API_KEY: 'xxx' },
    description: 'stdio 类型可选：环境变量（加密存储，响应中不回显）',
  })
  @IsObject()
  @IsOptional()
  env?: Record<string, string>;

  @ApiProperty({
    required: false,
    example: 'https://mcp.example.com/sse',
    description: 'sse / streamable-http 类型必填：连接地址',
  })
  @ValidateIf((o: CreateMcpServerDto) => o.type !== McpServerType.STDIO)
  @IsUrl({ require_tld: false }, { message: '必须提供合法的 url' })
  url?: string;

  @ApiProperty({
    required: false,
    example: { Authorization: 'Bearer xxx' },
    description: 'sse / streamable-http 类型可选：请求头（加密存储，响应中不回显）',
  })
  @IsObject()
  @IsOptional()
  headers?: Record<string, string>;

  @ApiProperty({
    required: false,
    example: '联网搜索工具',
    description: '描述（展示在 Agent 配置界面）',
  })
  @IsString()
  @Length(0, 255)
  @IsOptional()
  description?: string;
}
