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
    description: '工具名（LLM 调用时的 tool name，小写字母/数字/下划线）',
  })
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'name 只能包含小写字母、数字、下划线，且必须以字母开头',
  })
  name: string;

  @ApiProperty({
    example: '搜索最新 AI 资讯并整理为结构化日报，适合每日资讯汇总场景',
    description: '工具描述：LLM 依此决定何时调用，需写清能做什么、何时适合用',
  })
  @IsString()
  @Length(1, 500)
  description: string;

  @ApiProperty({ example: '你是一个 AI 日报撰写助手...', description: '子 Agent 的执行指令' })
  @IsString()
  @IsNotEmpty()
  systemPrompt: string;

  @ApiProperty({
    required: false,
    example: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    description: '入参 JSON Schema（仅支持扁平 object）；缺省时工具只接收单个 input 字符串',
  })
  @IsObject()
  @IsOptional()
  inputSchema?: Record<string, unknown>;

  @ApiProperty({
    required: false,
    type: [String],
    example: ['web_search'],
    description: '子 Agent 可用的内置工具名列表',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  enabledTools?: string[];

  @ApiProperty({
    required: false,
    type: [String],
    description: '子 Agent 可用的 MCP Server ID 列表（stdio 类型仅管理员可关联）',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  mcpServerIds?: string[];
}
