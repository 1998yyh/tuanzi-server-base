import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
  Index,
} from 'typeorm';
import { User } from '../users/users.entity';
import { McpServer } from '../mcp-servers/mcp-server.entity';

/**
 * Skill：配置级工具单元。底层是带 systemPrompt + 工具集的临时子 Agent，
 * 主 Agent 调用时借用其 provider/model/apiKey 执行（见 SkillToolFactory）。
 */
@Entity('skills')
export class Skill {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 工具名（LLM 调用时的 tool name，snake_case），全局唯一 */
  @Index({ unique: true })
  @Column({ length: 100 })
  name: string;

  /** 工具描述：LLM 依此决定何时调用，直接影响调用质量 */
  @Column({ type: 'varchar', length: 500 })
  description: string;

  /** 子 Agent 的执行指令（system prompt） */
  @Column({ name: 'system_prompt', type: 'text' })
  systemPrompt: string;

  /** 入参 JSON Schema；为空时工具只接收单个 input 字符串 */
  @Column({ name: 'input_schema', type: 'json', nullable: true })
  inputSchema: Record<string, unknown> | null;

  /** 子 Agent 可用的内置工具名列表 */
  @Column({ name: 'enabled_tools', type: 'json', nullable: true })
  enabledTools: string[] | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /** 子 Agent 可用的 MCP Server（skill_mcp_servers 关联表） */
  @ManyToMany(() => McpServer)
  @JoinTable({
    name: 'skill_mcp_servers',
    joinColumn: { name: 'skill_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'mcp_server_id', referencedColumnName: 'id' },
  })
  mcpServers: McpServer[];

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator: User;

  @Column({ name: 'created_by' })
  createdBy: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** API 响应形状：mcpServers 关系展开为 id 列表 */
export type SkillView = Omit<Skill, 'creator' | 'mcpServers'> & { mcpServerIds: string[] };
