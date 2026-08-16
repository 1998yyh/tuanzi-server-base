import { ApiProperty } from '@nestjs/swagger';
import { ApiFormat } from '../../ai-generation/entities/ai-channel.entity';

/**
 * Agent 配置响应形状：渠道信息只返回名称/格式等展示字段，密文绝不出现在响应中。
 * 由 AgentsService.toResponse() 显式挑选字段构造。
 */
export class AgentResponseDto {
  @ApiProperty({ example: 'uuid', description: 'Agent ID' })
  id: string;

  @ApiProperty({ example: '客服助手', description: 'Agent 名称' })
  name: string;

  @ApiProperty({ example: '处理售前咨询', description: 'Agent 描述', nullable: true })
  description: string | null;

  @ApiProperty({ example: 'uuid', description: '对话模型所属渠道 ID' })
  channelId: string;

  @ApiProperty({ example: '公司网关', description: '渠道名称', nullable: true })
  channelName: string | null;

  @ApiProperty({ enum: ApiFormat, example: 'openai', description: '渠道 API 格式', nullable: true })
  apiFormat: ApiFormat | null;

  @ApiProperty({ example: 'claude-opus-4-8', description: '对话模型名' })
  modelName: string;

  @ApiProperty({ example: '你是一个专业客服...', description: '系统提示词', nullable: true })
  systemPrompt: string | null;

  @ApiProperty({ example: 4096, description: '单次生成最大 token 数' })
  maxTokens: number;

  @ApiProperty({ example: 10, description: 'tool loop 最大轮次' })
  maxIterations: number;

  @ApiProperty({ type: [String], example: ['web_search'], description: '启用的内置工具名列表' })
  enabledTools: string[];

  @ApiProperty({ example: true, description: '是否启用（软删除后为 false）' })
  isActive: boolean;

  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
}
