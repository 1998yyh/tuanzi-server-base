import { BadRequestException, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { MediaFile } from './media-file.entity';
import { MediaService, MEDIA_DIR } from './media.service';
import { MediaController } from './media.controller';

/**
 * 上传类型白名单（2026-08-15 代码审查新增）：
 * 只信任「mimetype 大类 + 扩展名白名单」的组合，扩展名由服务端校验而非客户端任意指定，
 * 杜绝 .html/.svg 等可执行内容借道静态服务形成存储型 XSS。
 */
const MIME_EXT_WHITELIST: Record<'image' | 'video' | 'audio', string[]> = {
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  video: ['.mp4', '.webm', '.mov'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus'],
};

@Module({
  imports: [
    TypeOrmModule.forFeature([MediaFile]),
    MulterModule.register({
      storage: diskStorage({
        destination: MEDIA_DIR,
        filename: (req, file, callback) => {
          const ext = extname(file.originalname).toLowerCase();
          callback(null, `${randomUUID()}${ext}`);
        },
      }),
      fileFilter: (req, file, callback) => {
        const mimeMatch = file.mimetype.match(/^(image|video|audio)\//);
        if (!mimeMatch) {
          return callback(new BadRequestException('只支持图片、视频、音频文件'), false);
        }
        const ext = extname(file.originalname).toLowerCase();
        if (!MIME_EXT_WHITELIST[mimeMatch[1] as 'image' | 'video' | 'audio'].includes(ext)) {
          return callback(
            new BadRequestException('文件扩展名不受支持，请使用常见图片/视频/音频格式'),
            false,
          );
        }
        callback(null, true);
      },
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB
      },
    }),
  ],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
