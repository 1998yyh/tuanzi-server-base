import { ApiProperty } from '@nestjs/swagger';
import { McpServerConfig, ProviderType } from '../entities/agent-config.entity';

/**
 * Agent 配置响应形状：API Key 只返回脱敏后 4 位，密文绝不出现在响应中。
 * 由 AgentsService.toResponse() 显式挑选字段构造。
 */
export class AgentResponseDto {
  @ApiProperty({ example: 'uuid', description: 'Agent ID' })
  id: string;

  @ApiProperty({ example: '客服助手', description: 'Agent 名称' })
  name: string;

  @ApiProperty({ example: '处理售前咨询', description: 'Agent 描述', nullable: true })
  description: string | null;

  @ApiProperty({ enum: ProviderType, example: 'anthropic', description: 'LLM 供应商' })
  provider: ProviderType;

  @ApiProperty({ example: 'claude-opus-4-8', description: '模型名称' })
  model: string;

  @ApiProperty({ example: '****3xYz', description: '脱敏后的 API Key（仅后 4 位）' })
  apiKeyMasked: string;

  @ApiProperty({ example: '你是一个专业客服...', description: '系统提示词', nullable: true })
  systemPrompt: string | null;

  @ApiProperty({ example: 4096, description: '单次生成最大 token 数' })
  maxTokens: number;

  @ApiProperty({ example: 10, description: 'tool loop 最大轮次' })
  maxIterations: number;

  @ApiProperty({ type: [String], example: ['web_search'], description: '启用的内置工具名列表' })
  enabledTools: string[];

  @ApiProperty({ description: '挂载的 MCP Server 列表' })
  mcpServers: McpServerConfig[];

  @ApiProperty({ example: true, description: '是否启用（软删除后为 false）' })
  isActive: boolean;

  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
}
