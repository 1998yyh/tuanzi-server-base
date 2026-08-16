import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { readFile } from 'node:fs/promises';
import { assertPublicUrl } from '../common/utils/ssrf.util';
import { User } from '../users/users.entity';
import { MediaFileView, MediaKind, MediaSource } from '../media/media-file.entity';
import { MediaService } from '../media/media.service';
import { CanvasOpsService } from '../canvas/canvas-ops.service';
import { AiChannelsService } from './ai-channels.service';
import { ModelCapability } from './entities/ai-channel.entity';
import { GenerationTask, GenerationTaskStatus } from './entities/generation-task.entity';
import { GenerateImageDto } from './dto/generate-image.dto';
import { GenerateVideoDto } from './dto/generate-video.dto';
import { GenerateAudioDto } from './dto/generate-audio.dto';
import { QueryGenerationTasksDto } from './dto/query-generation-tasks.dto';
import {
  generateImages,
  GeneratedImageOutput,
  ReferenceImageInput,
  ResolvedChannelConfig,
} from './providers/image-generation.provider';
import {
  createVideoTask,
  downloadVideoContent,
  GenerateVideoRequest,
  pollVideoTask,
  resolveVideoProvider,
  VideoImageReference,
  VideoPollState,
  VideoTaskRef,
} from './providers/video-generation.provider';
import { generateAudio } from './providers/audio-generation.provider';
import {
  MAX_IMAGE_DOWNLOAD_BYTES,
  MAX_VIDEO_DOWNLOAD_BYTES,
  readBodyLimited,
} from './providers/stream-download.util';
import {
  seedanceVideoReferenceError,
  SEEDANCE_REFERENCE_LIMITS,
} from './providers/seedance-video.util';

type CurrentUser = Omit<User, 'password'>;

const MODEL_REF_SEPARATOR = '::';
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 参考音视频素材的绝对 URL 前缀（远端模型服务需要可公网拉取的地址） */
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`
).replace(/\/+$/, '');

export interface ResolvedChannel extends ResolvedChannelConfig {
  channelId: string;
}

/** 任务响应形状：剔除关系对象，附带结果媒体信息 */
export type GenerationTaskView = Omit<GenerationTask, 'user' | 'channel' | 'resultMedia'> & {
  resultMedia: MediaFileView | null;
};

/**
 * 生成服务：统一入口。负责渠道解析 + 解密、任务行生命周期、结果落盘。
 * provider 只负责「拼请求 + 解析响应」纯逻辑，便于 mock 测试。
 */
@Injectable()
export class GenerationService {
  private readonly logger = new Logger(GenerationService.name);

  constructor(
    @InjectRepository(GenerationTask)
    private readonly taskRepo: Repository<GenerationTask>,
    private readonly aiChannelsService: AiChannelsService,
    private readonly mediaService: MediaService,
    private readonly canvasOpsService: CanvasOpsService,
  ) {}

  /** 解析 "channelId::modelName" 并做归属/启用/能力校验，返回解密后的渠道配置 */
  async resolveChannelModel(
    userId: string,
    modelRef: string,
    capability: ModelCapability,
  ): Promise<ResolvedChannel> {
    const separatorIndex = modelRef.indexOf(MODEL_REF_SEPARATOR);
    if (separatorIndex <= 0 || separatorIndex === modelRef.length - MODEL_REF_SEPARATOR.length) {
      throw new BadRequestException('modelRef 格式必须为 "channelId::modelName"');
    }
    const channelId = modelRef.slice(0, separatorIndex);
    const modelName = modelRef.slice(separatorIndex + MODEL_REF_SEPARATOR.length);

    const { channel, apiKey } = await this.aiChannelsService.findWithKey(channelId);
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
    if (model.capability !== capability) {
      throw new BadRequestException(`模型 "${modelName}" 不是${capability}能力模型`);
    }
    return {
      channelId: channel.id,
      baseUrl: channel.baseUrl,
      apiKey,
      apiFormat: channel.apiFormat,
      model: model.name,
    };
  }

  /** 图片生成（同步）：文生图 / 参考图编辑 */
  async generateImage(
    user: CurrentUser,
    dto: GenerateImageDto,
  ): Promise<{ task: GenerationTaskView; media: MediaFileView[] }> {
    const resolved = await this.resolveChannelModel(user.id, dto.modelRef, ModelCapability.IMAGE);
    const references = await this.loadReferences(dto.referenceMediaIds ?? [], user.id);

    const task = await this.taskRepo.save(
      this.taskRepo.create({
        userId: user.id,
        channelId: resolved.channelId,
        model: resolved.model,
        capability: ModelCapability.IMAGE,
        status: GenerationTaskStatus.PROCESSING,
        prompt: dto.prompt,
        params: {
          count: dto.count ?? 1,
          quality: dto.quality,
          size: dto.size,
          background: dto.background,
          systemPrompt: dto.systemPrompt,
          referenceMediaIds: dto.referenceMediaIds,
        },
        nodeRef: dto.nodeRef ?? null,
      }),
    );

    try {
      const outputs = await generateImages(resolved, {
        prompt: this.assemblePrompt(dto.prompt, dto.systemPrompt, references.length),
        count: dto.count ?? 1,
        quality: dto.quality,
        size: dto.size,
        background: dto.background,
        references,
      });
      const media = await this.persistOutputs(user.id, outputs);
      await this.taskRepo.update(task.id, {
        status: GenerationTaskStatus.SUCCEEDED,
        resultMediaId: media[0]?.id ?? null,
        resultExtra: { mediaIds: media.map((m) => m.id) },
      });
      const fresh = await this.findTaskEntity(task.id);
      return { task: this.toTaskView(fresh), media };
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败';
      await this.taskRepo.update(task.id, { status: GenerationTaskStatus.FAILED, error: message });
      throw new BadRequestException(message);
    }
  }

  /** 视频生成（异步）：立即创建任务行，远端任务 ID 写入后由 cron 轮询驱动 */
  async generateVideo(
    user: CurrentUser,
    dto: GenerateVideoDto,
  ): Promise<{ task: GenerationTaskView }> {
    const resolved = await this.resolveChannelModel(user.id, dto.modelRef, ModelCapability.VIDEO);
    const provider = resolveVideoProvider(resolved);
    const references = await this.prepareVideoReferences(
      dto.referenceMediaIds ?? [],
      user.id,
      provider === 'seedance',
    );

    const task = await this.taskRepo.save(
      this.taskRepo.create({
        userId: user.id,
        channelId: resolved.channelId,
        model: resolved.model,
        capability: ModelCapability.VIDEO,
        status: GenerationTaskStatus.PENDING,
        prompt: dto.prompt,
        params: {
          provider,
          seconds: dto.seconds,
          size: dto.size,
          vquality: dto.vquality,
          generateAudio: dto.generateAudio,
          watermark: dto.watermark,
          referenceMediaIds: dto.referenceMediaIds,
        },
        nodeRef: dto.nodeRef ?? null,
      }),
    );

    const request: GenerateVideoRequest = {
      prompt: dto.prompt,
      seconds: dto.seconds,
      size: dto.size,
      vquality: dto.vquality,
      generateAudio: dto.generateAudio,
      watermark: dto.watermark,
      ...references,
    };
    try {
      const ref = await createVideoTask(resolved, request);
      await this.taskRepo.update(task.id, {
        status: GenerationTaskStatus.PROCESSING,
        remoteTaskId: ref.remoteTaskId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '视频任务创建失败';
      await this.taskRepo.update(task.id, { status: GenerationTaskStatus.FAILED, error: message });
      throw new BadRequestException(message);
    }
    return { task: this.toTaskView(await this.findTaskEntity(task.id)) };
  }

  /** 音频生成（同步）：/audio/speech 返回二进制直接落盘 */
  async generateAudio(
    user: CurrentUser,
    dto: GenerateAudioDto,
  ): Promise<{ task: GenerationTaskView; media: MediaFileView }> {
    const resolved = await this.resolveChannelModel(user.id, dto.modelRef, ModelCapability.AUDIO);

    const task = await this.taskRepo.save(
      this.taskRepo.create({
        userId: user.id,
        channelId: resolved.channelId,
        model: resolved.model,
        capability: ModelCapability.AUDIO,
        status: GenerationTaskStatus.PROCESSING,
        prompt: dto.prompt,
        params: {
          voice: dto.voice,
          format: dto.format,
          speed: dto.speed,
          instructions: dto.instructions,
        },
        nodeRef: dto.nodeRef ?? null,
      }),
    );

    try {
      const { buffer, mimeType } = await generateAudio(resolved, {
        prompt: dto.prompt,
        voice: dto.voice,
        format: dto.format,
        speed: dto.speed,
        instructions: dto.instructions,
      });
      const media = await this.mediaService.saveBuffer(user.id, buffer, {
        mimeType,
        kind: MediaKind.AUDIO,
        source: MediaSource.GENERATION,
      });
      await this.taskRepo.update(task.id, {
        status: GenerationTaskStatus.SUCCEEDED,
        resultMediaId: media.id,
      });
      const fresh = await this.findTaskEntity(task.id);
      return { task: this.toTaskView(fresh), media };
    } catch (error) {
      const message = error instanceof Error ? error.message : '音频生成失败';
      await this.taskRepo.update(task.id, { status: GenerationTaskStatus.FAILED, error: message });
      throw new BadRequestException(message);
    }
  }

  /** 轮询远端视频任务状态（供 generation-poller 调用，不做归属校验） */
  async pollVideoTaskState(task: GenerationTask): Promise<VideoPollState> {
    const config = await this.resolveChannelForTask(task);
    return pollVideoTask(config, this.videoTaskRef(task, config));
  }

  /** 视频任务成功：下载结果 → 落盘 → 更新任务 → 回填画布节点 */
  async completeVideoTask(task: GenerationTask, state: { url: string | null }): Promise<void> {
    const config = await this.resolveChannelForTask(task);
    const { buffer, mimeType } = state.url
      ? await this.downloadResult(state.url, MAX_VIDEO_DOWNLOAD_BYTES, 'video/mp4')
      : await downloadVideoContent(config, this.videoTaskRef(task, config));

    const media = await this.mediaService.saveBuffer(task.userId, buffer, {
      mimeType,
      kind: MediaKind.VIDEO,
      source: MediaSource.GENERATION,
    });
    await this.taskRepo.update(task.id, {
      status: GenerationTaskStatus.SUCCEEDED,
      resultMediaId: media.id,
    });
    await this.patchNodeMetadata(task, {
      status: 'success',
      content: media.url,
      storageKey: media.fileName,
      mimeType: media.mimeType,
      bytes: media.bytes,
      taskId: task.id,
    });
    this.logger.log(`视频任务 #${task.id} 完成，结果媒体 #${media.id}`);
  }

  /** 任务失败：更新任务行 + 回填画布节点错误态 */
  async failTask(task: GenerationTask, error: string): Promise<void> {
    await this.taskRepo.update(task.id, { status: GenerationTaskStatus.FAILED, error });
    await this.patchNodeMetadata(task, { status: 'error', errorDetails: error, taskId: task.id });
  }

  /** 按任务行还原渠道配置（轮询用：不走用户归属校验，但同样校验启用态） */
  private async resolveChannelForTask(task: GenerationTask): Promise<ResolvedChannel> {
    const { channel, apiKey } = await this.aiChannelsService.findWithKey(task.channelId);
    return {
      channelId: channel.id,
      baseUrl: channel.baseUrl,
      apiKey,
      apiFormat: channel.apiFormat,
      model: task.model,
    };
  }

  /** 还原创建时记录的 provider，缺省时按渠道格式推断（兼容旧任务行） */
  private videoTaskRef(task: GenerationTask, config: ResolvedChannel): VideoTaskRef {
    const provider =
      (task.params as { provider?: 'openai' | 'seedance' } | null)?.provider ??
      resolveVideoProvider(config);
    return { provider, remoteTaskId: task.remoteTaskId as string };
  }

  /** 回填画布节点元数据（无版本号单节点 patch，避免与前端编辑冲突） */
  private async patchNodeMetadata(
    task: GenerationTask,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const nodeRef = task.nodeRef as { projectId?: string; nodeId?: string } | null;
    if (!nodeRef?.projectId || !nodeRef.nodeId) return;
    try {
      await this.canvasOpsService.patchNodeMetadata(nodeRef.projectId, nodeRef.nodeId, metadata);
    } catch (error) {
      this.logger.warn(
        `任务 #${task.id} 回填画布节点失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** 从直链下载生成结果（SSRF 校验 + redirect manual + 流式大小上限） */
  private async downloadResult(
    url: string,
    maxBytes: number,
    defaultMime: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    return this.downloadToBuffer(url, maxBytes, defaultMime, '下载生成结果');
  }

  /** 视频参考素材：图片转 dataUrl，音视频转绝对 URL（Seedance 校验尺寸/数量） */
  private async prepareVideoReferences(
    mediaIds: string[],
    userId: string,
    isSeedance: boolean,
  ): Promise<{
    imageReferences?: VideoImageReference[];
    videoReferenceUrls?: string[];
    audioReferenceUrls?: string[];
  }> {
    if (!mediaIds.length) return {};
    const medias = await this.mediaService.findByIdsForUser(mediaIds, userId);
    const videos = medias.filter((m) => m.kind === MediaKind.VIDEO);
    if (isSeedance && videos.length) {
      const error = seedanceVideoReferenceError(videos);
      if (error) throw new BadRequestException(error);
    }

    const imageReferences: VideoImageReference[] = [];
    const videoReferenceUrls: string[] = [];
    const audioReferenceUrls: string[] = [];
    for (const media of medias) {
      if (media.kind === MediaKind.IMAGE) {
        if (media.bytes > SEEDANCE_REFERENCE_LIMITS.imageMaxBytes) {
          throw new BadRequestException(`参考图片 "${media.fileName}" 超过 30MB 限制`);
        }
        const buffer = await readFile(this.mediaService.diskPath(media));
        imageReferences.push({
          dataUrl: `data:${media.mimeType};base64,${buffer.toString('base64')}`,
          mimeType: media.mimeType,
          fileName: media.fileName,
        });
      } else if (media.kind === MediaKind.VIDEO) {
        videoReferenceUrls.push(`${PUBLIC_BASE_URL}${media.url}`);
      } else if (media.kind === MediaKind.AUDIO) {
        if (media.bytes > SEEDANCE_REFERENCE_LIMITS.audioMaxBytes) {
          throw new BadRequestException(`参考音频 "${media.fileName}" 超过 15MB 限制`);
        }
        audioReferenceUrls.push(`${PUBLIC_BASE_URL}${media.url}`);
      } else {
        throw new BadRequestException('视频参考素材只支持图片/视频/音频');
      }
    }
    return {
      imageReferences: imageReferences.length ? imageReferences : undefined,
      videoReferenceUrls: videoReferenceUrls.length ? videoReferenceUrls : undefined,
      audioReferenceUrls: audioReferenceUrls.length ? audioReferenceUrls : undefined,
    };
  }

  async findTasks(
    user: CurrentUser,
    query: QueryGenerationTasksDto,
  ): Promise<{
    items: GenerationTaskView[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const qb = this.taskRepo
      .createQueryBuilder('t')
      .leftJoinAndMapOne('t.resultMedia', 't.resultMedia', 'rm')
      .where('t.user_id = :userId', { userId: user.id })
      .orderBy('t.createdAt', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);
    if (query.capability)
      qb.andWhere('t.capability = :capability', { capability: query.capability });
    if (query.status) qb.andWhere('t.status = :status', { status: query.status });

    const [items, total] = await qb.getManyAndCount();
    return {
      items: items.map((t) => this.toTaskView(t)),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async findTask(user: CurrentUser, id: string): Promise<GenerationTaskView> {
    const task = await this.taskRepo.findOne({ where: { id }, relations: ['resultMedia'] });
    if (!task) {
      throw new NotFoundException(`生成任务 #${id} 不存在`);
    }
    if (task.userId !== user.id) {
      throw new ForbiddenException('只能查看自己的生成任务');
    }
    return this.toTaskView(task);
  }

  private async findTaskEntity(id: string): Promise<GenerationTask> {
    const task = await this.taskRepo.findOne({ where: { id }, relations: ['resultMedia'] });
    if (!task) throw new NotFoundException(`生成任务 #${id} 不存在`);
    return task;
  }

  /** 读取参考图：校验归属后从磁盘读出 buffer */
  private async loadReferences(mediaIds: string[], userId: string): Promise<ReferenceImageInput[]> {
    const medias = await this.mediaService.findByIdsForUser(mediaIds, userId);
    const images = medias.filter((m) => m.kind === MediaKind.IMAGE);
    if (images.length !== medias.length) {
      throw new BadRequestException('参考素材只能是图片');
    }
    return Promise.all(
      images.map(async (media) => ({
        buffer: await readFile(this.mediaService.diskPath(media)),
        mimeType: media.mimeType,
        fileName: media.fileName,
      })),
    );
  }

  /** 拼装最终 prompt：systemPrompt 前缀 + 参考图编号说明 */
  private assemblePrompt(
    prompt: string,
    systemPrompt: string | undefined,
    referenceCount: number,
  ): string {
    let text = prompt;
    if (referenceCount > 0) {
      const labels = Array.from({ length: referenceCount }, (_, i) => `参考图 ${i + 1}`).join('、');
      text = `${labels}。${text}`;
    }
    const system = systemPrompt?.trim();
    return system ? `${system}\n\n${text}` : text;
  }

  /** 把 provider 输出统一落盘：b64 解码 / url 下载 → MediaService.saveBuffer */
  private async persistOutputs(
    userId: string,
    outputs: GeneratedImageOutput[],
  ): Promise<MediaFileView[]> {
    const media: MediaFileView[] = [];
    for (const output of outputs) {
      const { buffer, mimeType } = await this.outputToBuffer(output);
      media.push(
        await this.mediaService.saveBuffer(userId, buffer, {
          mimeType,
          kind: MediaKind.IMAGE,
          source: MediaSource.GENERATION,
        }),
      );
    }
    return media;
  }

  private async outputToBuffer(
    output: GeneratedImageOutput,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    if (output.kind === 'b64') {
      return { buffer: Buffer.from(output.data, 'base64'), mimeType: 'image/png' };
    }
    return this.downloadToBuffer(output.url, MAX_IMAGE_DOWNLOAD_BYTES, 'image/png', '下载生成结果');
  }

  /**
   * 统一出站下载：SSRF 校验（assertPublicUrl）→ redirect: manual（重定向拒绝）
   * → Content-Length 预检 + 流式读取累计字节，超限中止（不无上限 arrayBuffer）。
   */
  private async downloadToBuffer(
    url: string,
    maxBytes: number,
    defaultMime: string,
    label: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const checkedUrl = await assertPublicUrl(url);
    const response = await fetch(checkedUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new Error(`${label}失败（响应重定向，已拒绝）`);
    }
    if (!response.ok) {
      throw new Error(`${label}失败（HTTP ${response.status}）`);
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > maxBytes) {
      throw new Error(`${label}超过大小限制（${Math.round(maxBytes / 1024 / 1024)}MB）`);
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0] || defaultMime;
    const buffer = await readBodyLimited(
      response,
      maxBytes,
      `${label}超过大小限制（${Math.round(maxBytes / 1024 / 1024)}MB）`,
    );
    return { buffer, mimeType };
  }

  toTaskView(task: GenerationTask): GenerationTaskView {
    const { user: _user, channel: _channel, resultMedia, ...rest } = task;
    void _user;
    void _channel;
    return { ...rest, resultMedia: resultMedia ? this.mediaService.toView(resultMedia) : null };
  }
}
