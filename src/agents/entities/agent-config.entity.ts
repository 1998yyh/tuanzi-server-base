import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  ManyToMany,
  JoinColumn,
  JoinTable,
} from 'typeorm';
import { User } from '../../users/users.entity';
import { McpServer } from '../../mcp-servers/mcp-server.entity';
import { Skill } from '../../skills/skill.entity';
import { Conversation } from './conversation.entity';
import { AiChannel } from '../../ai-generation/entities/ai-channel.entity';

/** @deprecated 旧 JSON 内联配置，已迁移到 mcp_servers 表；仅 legacyMcpServers 字段使用 */
export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string; // stdio 模式：如 "npx @modelcontextprotocol/server-filesystem /tmp"
  url?: string; // sse 模式：服务端 URL
}

@Entity('agent_configs')
export class AgentConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ── 用户归属（多用户隔离核心字段）──────────────────────────
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: string;
  // ─────────────────────────────────────────────────────────

  @Column({ length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 对话模型所属渠道（ai_channels.id；FK RESTRICT：被引用时禁止删除渠道） */
  @ManyToOne(() => AiChannel, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'channel_id' })
  channel: AiChannel;

  @Column({ name: 'channel_id' })
  channelId: string;

  /** 渠道下的对话模型名（capability=chat，「对话」用途） */
  @Column({ name: 'model_name', length: 100 })
  modelName: string;

  @Column({ name: 'system_prompt', type: 'text', nullable: true })
  systemPrompt: string | null;

  @Column({ name: 'max_tokens', default: 4096 })
  maxTokens: number;

  /** tool loop 最大轮次，防止无限循环 */
  @Column({ name: 'max_iterations', default: 10 })
  maxIterations: number;

  /**
   * @deprecated 旧 JSON 内联 MCP 配置，已迁移到 mcp_servers + agent_config_mcp_servers。
   * 保留列待数据迁移完成后删除；代码不再读写。
   */
  @Column({ name: 'mcp_servers', type: 'json', nullable: true })
  legacyMcpServers: McpServerConfig[] | null;

  /** 关联的全局 MCP Server（agent_config_mcp_servers 关联表） */
  @ManyToMany(() => McpServer)
  @JoinTable({
    name: 'agent_config_mcp_servers',
    joinColumn: { name: 'agent_config_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'mcp_server_id', referencedColumnName: 'id' },
  })
  mcpServers: McpServer[];

  /** 关联的 Skill（agent_config_skills 关联表） */
  @ManyToMany(() => Skill)
  @JoinTable({
    name: 'agent_config_skills',
    joinColumn: { name: 'agent_config_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'skill_id', referencedColumnName: 'id' },
  })
  skills: Skill[];

  /** 启用的内置工具名列表 */
  @Column({ name: 'enabled_tools', type: 'json', nullable: true })
  enabledTools: string[] | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @OneToMany(() => Conversation, (c) => c.agentConfig)
  conversations: Conversation[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
