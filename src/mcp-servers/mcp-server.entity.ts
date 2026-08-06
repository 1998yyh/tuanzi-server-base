import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../users/users.entity';

/** MCP 连接类型。stdio 会在服务端执行子进程，仅管理员可创建/关联 */
export enum McpServerType {
  STDIO = 'stdio',
  SSE = 'sse',
  STREAMABLE_HTTP = 'streamable-http',
}

/**
 * 全局 MCP Server 工具库：Admin 集中配置，普通用户选配给自己的 Agent。
 * env/headers 为敏感配置，AES-256-GCM 加密存储（列名 env/headers，存密文），
 * 绝不明文落库、绝不出现在 API 响应。
 */
@Entity('mcp_servers')
@Index(['type', 'isActive'])
export class McpServer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 100 })
  name: string;

  @Column({ type: 'enum', enum: McpServerType })
  type: McpServerType;

  /** stdio 专用：可执行命令 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  command: string | null;

  /** stdio 专用：命令参数数组 */
  @Column({ type: 'json', nullable: true })
  args: string[] | null;

  /** stdio 专用：环境变量 JSON 的 AES-256-GCM 密文 */
  @Column({ name: 'env', type: 'text', nullable: true })
  envEncrypted: string | null;

  /** sse / streamable-http 专用：连接地址 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  url: string | null;

  /** sse / streamable-http 专用：请求头 JSON 的 AES-256-GCM 密文 */
  @Column({ name: 'headers', type: 'text', nullable: true })
  headersEncrypted: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

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

/** API 响应形状：密文字段与 creator 关系对象绝不出现在响应中 */
export type McpServerView = Omit<McpServer, 'envEncrypted' | 'headersEncrypted' | 'creator'>;

/** Agent 执行时使用的运行时配置：env/headers 已解密为对象 */
export interface McpServerRuntimeConfig {
  name: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
