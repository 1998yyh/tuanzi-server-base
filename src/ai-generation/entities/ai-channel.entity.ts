import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/users.entity';

/** 渠道 API 格式（决定请求/响应的拼装方式；「对话」用途仅支持 openai / anthropic） */
export enum ApiFormat {
  OPENAI = 'openai',
  GEMINI = 'gemini',
  ARK = 'ark',
  ANTHROPIC = 'anthropic',
}

/** 模型能力（chat = 对话，供 Agent 使用；image/video/audio = 生成，供画布使用） */
export enum ModelCapability {
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  CHAT = 'chat',
}

/** 渠道下单个模型的配置 */
export interface ChannelModel {
  name: string;
  capability: ModelCapability;
  /** 自定义调用脚本：v1 服务端不支持执行，仅保留字段形状（见设计文档） */
  script?: string;
}

/**
 * AI 生成渠道：一个 OpenAI 兼容 / Gemini / Ark 接口端点 + API Key + 模型清单。
 * apiKey 使用 AES-256-GCM 加密存储，绝不明文落库、绝不出现在 API 响应。
 * Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
 */
@Entity('ai_channels')
export class AiChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ length: 100 })
  name: string;

  @Column({ name: 'api_format', type: 'enum', enum: ApiFormat })
  apiFormat: ApiFormat;

  @Column({ name: 'base_url', length: 500 })
  baseUrl: string;

  /** API Key 的 AES-256-GCM 密文 */
  @Column({ name: 'api_key', type: 'text' })
  apiKeyEncrypted: string;

  /** 模型清单：[{ name, capability, script? }] */
  @Column({ type: 'json' })
  models: ChannelModel[];

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** API 响应形状：密文与 user 关系对象绝不出现在响应中，apiKey 只回脱敏值 */
export type AiChannelView = Omit<AiChannel, 'user' | 'apiKeyEncrypted'> & {
  apiKeyMasked: string;
};
