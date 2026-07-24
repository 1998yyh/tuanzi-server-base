import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/users.entity';
import { Conversation } from './conversation.entity';

/** LLM 供应商：扩展时在此添加，AgentExecutorService.createModelFromConfig 的 switch 分支同步更新 */
export enum ProviderType {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  DEEPSEEK = 'deepseek',
}

/** MCP Server 配置。stdio 模式会在服务端执行子进程，仅管理员可配置 */
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

  @Column({ type: 'enum', enum: ProviderType })
  provider: ProviderType;

  @Column({ length: 100 })
  model: string;

  /** AES-256-GCM 加密存储，绝不明文落库、绝不出现在 API 响应 */
  @Column({ name: 'api_key_encrypted', type: 'text' })
  apiKeyEncrypted: string;

  @Column({ name: 'system_prompt', type: 'text', nullable: true })
  systemPrompt: string | null;

  @Column({ name: 'max_tokens', default: 4096 })
  maxTokens: number;

  /** tool loop 最大轮次，防止无限循环 */
  @Column({ name: 'max_iterations', default: 10 })
  maxIterations: number;

  /** MySQL JSON 列不支持字面默认值，用 nullable 代替，读取处 ?? [] */
  @Column({ name: 'mcp_servers', type: 'json', nullable: true })
  mcpServers: McpServerConfig[] | null;

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
