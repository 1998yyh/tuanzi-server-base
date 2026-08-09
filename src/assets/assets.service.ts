import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/users.entity';
import { MediaFileView, MediaKind, MediaSource } from '../media/media-file.entity';
import { MediaService } from '../media/media.service';
import { Asset, AssetKind } from './asset.entity';
import { CreateAssetDto, QueryAssetsDto } from './dto/asset.dto';

type CurrentUser = Omit<User, 'password'>;

/** API 响应形状：剔除 user 关系，附带媒体视图 */
export type AssetView = Omit<Asset, 'user' | 'media'> & { media: MediaFileView | null };

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(Asset)
    private readonly assetRepo: Repository<Asset>,
    private readonly mediaService: MediaService,
  ) {}

  async create(user: CurrentUser, dto: CreateAssetDto): Promise<AssetView> {
    if (dto.kind === AssetKind.TEXT) {
      if (!dto.textContent?.trim()) throw new BadRequestException('文本素材必须提供内容');
    } else {
      if (!dto.mediaId) throw new BadRequestException('图片/视频素材必须提供 mediaId');
      const media = await this.mediaService.findByIdsForUser([dto.mediaId], user.id);
      if (!media.length) throw new BadRequestException('媒体文件不存在或不属于当前用户');
    }
    const asset = await this.assetRepo.save(
      this.assetRepo.create({
        userId: user.id,
        kind: dto.kind,
        title: dto.title,
        textContent: dto.kind === AssetKind.TEXT ? dto.textContent : null,
        mediaId: dto.kind === AssetKind.TEXT ? null : (dto.mediaId ?? null),
        tags: dto.tags ?? null,
        source: dto.source ?? '',
        note: dto.note ?? '',
      }),
    );
    return this.findOne(user, asset.id);
  }

  /** Agent 工具用：从远程 URL 或 dataURL 导入图片素材 */
  async addImageFromUrl(
    user: CurrentUser,
    input: { title: string; imageUrl: string; tags?: string[]; source?: string; note?: string },
  ): Promise<AssetView> {
    const { buffer, mimeType } = await this.fetchImage(input.imageUrl);
    const media = await this.mediaService.saveBuffer(user.id, buffer, {
      mimeType,
      kind: MediaKind.IMAGE,
      source: MediaSource.IMPORT,
    });
    return this.create(user, {
      kind: AssetKind.IMAGE,
      title: input.title,
      mediaId: media.id,
      tags: input.tags,
      source: input.source,
      note: input.note,
    });
  }

  async findAll(
    user: CurrentUser,
    query: QueryAssetsDto,
  ): Promise<{
    items: AssetView[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const qb = this.assetRepo
      .createQueryBuilder('a')
      .leftJoinAndMapOne('a.media', 'a.media', 'm')
      .where('a.user_id = :userId', { userId: user.id })
      .orderBy('a.createdAt', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);
    if (query.kind) qb.andWhere('a.kind = :kind', { kind: query.kind });
    if (query.keyword?.trim()) {
      qb.andWhere('(a.title LIKE :kw OR a.text_content LIKE :kw OR a.note LIKE :kw)', {
        kw: `%${query.keyword.trim()}%`,
      });
    }
    const [items, total] = await qb.getManyAndCount();
    return {
      items: items.map((a) => this.toView(a)),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async findOne(user: CurrentUser, id: string): Promise<AssetView> {
    const asset = await this.assetRepo.findOne({
      where: { id, userId: user.id },
      relations: ['media'],
    });
    if (!asset) throw new NotFoundException(`素材 #${id} 不存在`);
    return this.toView(asset);
  }

  async remove(user: CurrentUser, id: string): Promise<void> {
    const asset = await this.assetRepo.findOne({ where: { id, userId: user.id } });
    if (!asset) throw new NotFoundException(`素材 #${id} 不存在`);
    await this.assetRepo.remove(asset);
  }

  /** 下载远程图片 / 解码 dataURL，统一为 buffer */
  private async fetchImage(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const dataUrlMatch = imageUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
    if (dataUrlMatch) {
      const buffer = Buffer.from(dataUrlMatch[2], 'base64');
      if (buffer.byteLength > MAX_IMPORT_BYTES) throw new BadRequestException('图片超过 50MB 限制');
      return { buffer, mimeType: dataUrlMatch[1] };
    }
    if (!/^https?:\/\//i.test(imageUrl)) {
      throw new BadRequestException('imageUrl 必须是 http(s) 地址或 dataURL');
    }
    let response: Response;
    try {
      response = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new BadRequestException('图片下载失败，请检查地址是否可访问');
    }
    if (!response.ok) throw new BadRequestException(`图片下载失败（HTTP ${response.status}）`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_IMPORT_BYTES) throw new BadRequestException('图片超过 50MB 限制');
    const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/png';
    if (!mimeType.startsWith('image/')) throw new BadRequestException('地址内容不是图片');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMPORT_BYTES) throw new BadRequestException('图片超过 50MB 限制');
    return { buffer, mimeType };
  }

  private toView(asset: Asset): AssetView {
    const { user: _user, media, ...rest } = asset;
    void _user;
    return { ...rest, media: media ? this.mediaService.toView(media) : null };
  }
}
