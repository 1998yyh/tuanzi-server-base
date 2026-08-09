import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { MediaFile } from './media-file.entity';
import { MediaService, MEDIA_DIR } from './media.service';
import { MediaController } from './media.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([MediaFile]),
    MulterModule.register({
      storage: diskStorage({
        destination: MEDIA_DIR,
        filename: (req, file, callback) => {
          callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`);
        },
      }),
      fileFilter: (req, file, callback) => {
        if (!file.mimetype.match(/^(image|video|audio)\//)) {
          return callback(new Error('只支持图片、视频、音频文件'), false);
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
