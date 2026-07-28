import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

export class CreateSkillDto {
  @ApiProperty({
    example: 'generate_ai_report',
    description: '工具名（LLM 调用时的 tool name），仅小写字母/数字/下划线，全局唯一',
  })
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z0-9_]+$/, { message: 'name 仅允许小写字母、数字、下划线' })
  name: string;

  @ApiProperty({ example: '生成 AI 日报', description: '工具描述：LLM 依此决定何时调用' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 500)
  description: string;

  @ApiProperty({ example: '你是日报撰写助手', description: '子 Agent 的执行指令（system prompt）' })
  @IsString()
  @IsNotEmpty()
  systemPrompt: string;

  @ApiProperty({
    required: false,
    example: { type: 'object', properties: { topic: { type: 'string' } } },
    description: '入参 JSON Schema；为空时工具只接收单个 input 字符串',
  })
  @IsObject()
  @IsOptional()
  inputSchema?: Record<string, unknown>;

  @ApiProperty({
    required: false,
    example: ['web_search'],
    description: '子 Agent 可用的内置工具名列表',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  enabledTools?: string[];

  @ApiProperty({
    required: false,
    example: ['3f6b2a1e-7c4d-4e8f-9a0b-1c2d3e4f5a6b'],
    description: '子 Agent 可用的 MCP Server id 列表（须存在且启用中）',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  mcpServerIds?: string[];
}
