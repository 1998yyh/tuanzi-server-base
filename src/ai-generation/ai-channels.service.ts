import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/users.entity';
import { AGENT_ENCRYPTION_KEY } from '../agents/utils/encryption-key.provider';
import { AgentConfig } from '../agents/entities/agent-config.entity';
import { decrypt, encrypt, maskApiKey } from '../common/utils/crypto.util';
import {
  AiChannel,
  AiChannelView,
  ApiFormat,
  ChannelModel,
  ModelCapability,
} from './entities/ai-channel.entity';
import { CreateAiChannelDto } from './dto/create-ai-channel.dto';
import { UpdateAiChannelDto } from './dto/update-ai-channel.dto';

type CurrentUser = Omit<User, 'password'>;

/** 对话模型解析结果（apiKey 已解密，只活在调用方栈帧） */
export interface ResolvedChatModel {
  channelId: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** AI 生成渠道管理：CRUD + API Key 加解密（复用 Agent 模块的 AES-256-GCM 基础设施） */
@Injectable()
export class AiChannelsService {
  constructor(
    @InjectRepository(AiChannel)
    private readonly channelRepo: Repository<AiChannel>,
    @InjectRepository(AgentConfig)
    private readonly agentRepo: Repository<AgentConfig>,
    @Inject(AGENT_ENCRYPTION_KEY)
    private readonly encryptionKey: string,
  ) {}

  /** 支持「对话」用途的协议格式：chat 走 LangChain ChatModel，仅这两类有对应实现 */
  private static readonly CHAT_CAPABLE_FORMATS: ReadonlySet<ApiFormat> = new Set([
    ApiFormat.OPENAI,
    ApiFormat.ANTHROPIC,
  ]);

  /** 「对话」用途的模型只允许挂在 openai / anthropic 格式的渠道上 */
  private validateModels(apiFormat: ApiFormat, models: ChannelModel[]): void {
    for (const m of models) {
      if (
        m.capability === ModelCapability.CHAT &&
        !AiChannelsService.CHAT_CAPABLE_FORMATS.has(apiFormat)
      ) {
        throw new BadRequestException(
          `apiFormat 为 "${apiFormat}" 的渠道不支持「对话」用途的模型（「对话」用途仅支持 openai / anthropic 格式）`,
        );
      }
    }
  }

  async create(user: CurrentUser, dto: CreateAiChannelDto): Promise<AiChannelView> {
    this.validateModels(dto.apiFormat, dto.models);
    const channel = await this.channelRepo.save(
      this.channelRepo.create({
        userId: user.id,
        name: dto.name,
        apiFormat: dto.apiFormat,
        baseUrl: dto.baseUrl,
        apiKeyEncrypted: encrypt(dto.apiKey, this.encryptionKey),
        models: dto.models,
        isActive: dto.isActive ?? true,
      }),
    );
    return this.toView(channel);
  }

  async findAll(user: CurrentUser): Promise<AiChannelView[]> {
    const channels = await this.channelRepo.find({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
    });
    return channels.map((c) => this.toView(c));
  }

  async update(user: CurrentUser, id: string, dto: UpdateAiChannelDto): Promise<AiChannelView> {
    const channel = await this.findOwned(id, user.id);

    // 按「合并后」的 apiFormat + models 校验（dto 只传其一时用现值兜底）
    this.validateModels(dto.apiFormat ?? channel.apiFormat, dto.models ?? channel.models);

    if (dto.name !== undefined) channel.name = dto.name;
    if (dto.apiFormat !== undefined) channel.apiFormat = dto.apiFormat;
    if (dto.baseUrl !== undefined) channel.baseUrl = dto.baseUrl;
    if (dto.models !== undefined) channel.models = dto.models;
    if (dto.isActive !== undefined) channel.isActive = dto.isActive;
    if (dto.apiKey !== undefined) {
      channel.apiKeyEncrypted = encrypt(dto.apiKey, this.encryptionKey);
    }

    const saved = await this.channelRepo.save(channel);
    return this.toView(saved);
  }

  async remove(user: CurrentUser, id: string): Promise<void> {
    const channel = await this.findOwned(id, user.id);
    // 有启用中的 Agent 引用时禁止删除（DB 层还有 FK RESTRICT 兜底，这里是友好报错 + 引用者清单）
    const referencingAgents = await this.agentRepo.find({
      where: { channelId: id, isActive: true },
      select: ['id', 'name'],
    });
    if (referencingAgents.length > 0) {
      throw new BadRequestException({
        message: `该渠道正被 ${referencingAgents.length} 个 Agent 引用，请先修改或删除相关 Agent`,
        referencingAgents: referencingAgents.map((a) => ({ id: a.id, name: a.name })),
      });
    }
    await this.channelRepo.remove(channel);
  }

  /** 执行用：解密后的渠道实体（apiKey 只活在调用方栈帧） */
  async findWithKey(id: string): Promise<{ channel: AiChannel; apiKey: string }> {
    const channel = await this.channelRepo.findOne({ where: { id } });
    if (!channel) {
      throw new NotFoundException(`AI 渠道 #${id} 不存在`);
    }
    return { channel, apiKey: decrypt(channel.apiKeyEncrypted, this.encryptionKey) };
  }

  /** 轻量查询（不解密）：供 Agent 响应拼装渠道名/格式 */
  async getById(id: string): Promise<AiChannel | null> {
    return this.channelRepo.findOne({ where: { id } });
  }

  /** 执行用：解析对话模型，做归属/启用/存在性/能力校验，返回解密后的渠道配置 */
  async resolveChatModel(
    userId: string,
    channelId: string,
    modelName: string,
  ): Promise<ResolvedChatModel> {
    const { channel, apiKey } = await this.findWithKey(channelId);
    if (channel.userId !== userId) {
      throw new ForbiddenException('只能使用自己的 AI 渠道');
    }
    if (!channel.isActive) {
      throw new BadRequestException(`渠道 "${channel.name}" 已停用`);
    }
    const model = channel.models.find((m) => m.name === modelName);
    if (!model) {
      throw new BadRequestException(`渠道 "${channel.name}" 下不存在模型 "${modelName}"`);
    }
    if (model.capability !== ModelCapability.CHAT) {
      throw new BadRequestException(`模型 "${modelName}" 的用途不是「对话」`);
    }
    return {
      channelId: channel.id,
      apiFormat: channel.apiFormat,
      baseUrl: channel.baseUrl,
      apiKey,
      model: model.name,
    };
  }

  private async findOwned(id: string, userId: string): Promise<AiChannel> {
    const channel = await this.channelRepo.findOne({ where: { id } });
    if (!channel) {
      throw new NotFoundException(`AI 渠道 #${id} 不存在`);
    }
    if (channel.userId !== userId) {
      throw new ForbiddenException('只能操作自己的 AI 渠道');
    }
    return channel;
  }

  /** 响应脱敏：显式挑选字段，密文不出现在响应中 */
  toView(channel: AiChannel): AiChannelView {
    const { user: _user, apiKeyEncrypted, ...rest } = channel;
    void _user;
    return {
      ...rest,
      apiKeyMasked: maskApiKey(decrypt(apiKeyEncrypted, this.encryptionKey)),
    };
  }
}
