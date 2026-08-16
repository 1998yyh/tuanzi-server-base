import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { MediaFile, MediaFileView, MediaKind, MediaSource } from './media-file.entity';

/** 磁盘存储目录（main.ts 已将 ./uploads 静态服务到 /uploads/ 前缀） */
export const MEDIA_DIR = join(process.cwd(), 'uploads', 'media');
export const MEDIA_URL_PREFIX = '/uploads/media';

/**
 * MIME → 扩展名映射（saveBuffer 用，未知类型回退 .bin）。
 * 注意：svg/html 等可执行内容一律不在此列（2026-08-15 代码审查：防存储型 XSS）。
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/opus': '.opus',
};

/** image-size 嗅探类型 → 扩展名（saveBuffer 按真实内容修正落盘扩展名） */
const SNIFF_TYPE_TO_EXT: Record<string, string> = {
  png: '.png',
  jpg: '.jpg',
  webp: '.webp',
  gif: '.gif',
  avif: '.avif',
};

export interface SaveBufferOptions {
  mimeType: string;
  kind: MediaKind;
  source: MediaSource;
  /** 视频/音频时长（毫秒），调用方已知时传入 */
  durationMs?: number;
}

/**
 * 媒体文件服务：统一处理「用户上传」（multer 已落盘）与「AI 生成结果」（内存 buffer 落盘）。
 * 二进制不进数据库，本表只存元数据。
 */
@Injectable()
export class MediaService {
  constructor(
    @InjectRepository(MediaFile)
    private readonly mediaRepo: Repository<MediaFile>,
  ) {}

  /** multer diskStorage 落盘后的登记（用户上传入口） */
  async saveUpload(userId: string, file: Express.Multer.File): Promise<MediaFileView> {
    const kind = this.kindFromMime(file.mimetype);
    let dimensions: { width: number; height: number } | null = null;
    try {
      if (kind === MediaKind.IMAGE) {
        // 真实内容嗅探：mimetype 可伪造，图片必须能被 image-size 识别
        dimensions = await this.readImageSize(file.path);
        if (!dimensions) {
          throw new BadRequestException('文件内容不是有效的图片');
        }
      }
      const media = await this.mediaRepo.save(
        this.mediaRepo.create({
          userId,
          kind,
          fileName: file.filename,
          url: `${MEDIA_URL_PREFIX}/${file.filename}`,
          mimeType: file.mimetype,
          bytes: file.size,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          durationMs: null,
          source: MediaSource.UPLOAD,
        }),
      );
      return this.toView(media);
    } catch (error) {
      // 落盘与登记非原子：登记失败时清理已写入的文件，避免孤儿文件残留
      await unlink(file.path).catch(() => undefined);
      throw error;
    }
  }

  /** 内存 buffer 落盘 + 登记（AI 生成结果的主写入路径） */
  async saveBuffer(
    userId: string,
    buffer: Buffer,
    options: SaveBufferOptions,
  ): Promise<MediaFileView> {
    // 按真实内容嗅探：防止声明为 image/* 的可执行内容落盘；嗅探失败视为无效图片
    const sniffedType =
      options.kind === MediaKind.IMAGE ? this.readImageSizeFromBuffer(buffer) : null;
    if (options.kind === MediaKind.IMAGE && !sniffedType) {
      throw new BadRequestException('图片内容无效');
    }
    if (options.kind === MediaKind.IMAGE && options.mimeType === 'image/svg+xml') {
      throw new BadRequestException('不支持 SVG 图片');
    }
    const ext =
      (sniffedType && SNIFF_TYPE_TO_EXT[sniffedType.type]) ||
      EXT_BY_MIME[options.mimeType] ||
      '.bin';
    const fileName = `${randomUUID()}${ext}`;
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(join(MEDIA_DIR, fileName), buffer);

    try {
      const dimensions = sniffedType
        ? { width: sniffedType.width, height: sniffedType.height }
        : null;
      const media = await this.mediaRepo.save(
        this.mediaRepo.create({
          userId,
          kind: options.kind,
          fileName,
          url: `${MEDIA_URL_PREFIX}/${fileName}`,
          mimeType: options.mimeType,
          bytes: buffer.byteLength,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          durationMs: options.durationMs ?? null,
          source: options.source,
        }),
      );
      return this.toView(media);
    } catch (error) {
      // 登记失败时清理已写入的文件，避免孤儿文件残留
      await unlink(join(MEDIA_DIR, fileName)).catch(() => undefined);
      throw error;
    }
  }

  async findById(id: string): Promise<MediaFile> {
    const media = await this.mediaRepo.findOne({ where: { id } });
    if (!media) {
      throw new NotFoundException(`媒体文件 #${id} 不存在`);
    }
    return media;
  }

  /** 批量查询并校验归属（生成参考图等场景） */
  async findByIdsForUser(ids: string[], userId: string): Promise<MediaFile[]> {
    if (!ids.length) return [];
    // TypeORM 0.3 已废弃 findByIds，改用 In() 查询
    const medias = await this.mediaRepo.find({ where: { id: In(ids) } });
    const found = new Set(medias.map((m) => m.id));
    const missing = ids.find((id) => !found.has(id));
    if (missing) {
      throw new NotFoundException(`媒体文件 #${missing} 不存在`);
    }
    const others = medias.find((m) => m.userId !== userId);
    if (others) {
      throw new BadRequestException('只能使用自己的媒体文件作为参考素材');
    }
    return medias;
  }

  /** 媒体文件的磁盘绝对路径（读取内容走 fs） */
  diskPath(media: MediaFile): string {
    return join(MEDIA_DIR, media.fileName);
  }

  toView(media: MediaFile): MediaFileView {
    const { user: _user, ...view } = media;
    return view;
  }

  private kindFromMime(mimeType: string): MediaKind {
    if (mimeType.startsWith('image/')) return MediaKind.IMAGE;
    if (mimeType.startsWith('video/')) return MediaKind.VIDEO;
    if (mimeType.startsWith('audio/')) return MediaKind.AUDIO;
    return MediaKind.FILE;
  }

  private async readImageSize(filePath: string): Promise<{ width: number; height: number } | null> {
    try {
      const { readFile } = await import('node:fs/promises');
      return this.readImageSizeFromBuffer(await readFile(filePath));
    } catch {
      return null;
    }
  }

  private readImageSizeFromBuffer(
    buffer: Buffer,
  ): { width: number; height: number; type: string } | null {
    try {
      const { width, height, type } = imageSize(buffer);
      return width && height && type ? { width, height, type } : null;
    } catch {
      return null;
    }
  }
}
