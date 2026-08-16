import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaService } from 'src/media/media.service';
import { MediaFile, MediaKind, MediaSource } from 'src/media/media-file.entity';

// saveBuffer 会真实写盘，测试中拦截 fs 避免产生文件
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  writeFile: jest.fn(async () => undefined),
  unlink: jest.fn(async () => undefined),
  readFile: jest.fn(async () => Buffer.from('')),
}));

/** 1x1 透明 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('MediaService', () => {
  let service: MediaService;
  let repo: jest.Mocked<Repository<MediaFile>>;
  const { unlink: mockUnlink, writeFile: mockWriteFile } = jest.requireMock('node:fs/promises') as {
    unlink: jest.Mock;
    writeFile: jest.Mock;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        {
          provide: getRepositoryToken(MediaFile),
          useValue: {
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => ({
              id: 'media-1',
              createdAt: new Date(),
              updatedAt: new Date(),
              ...v,
            })),
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(MediaService);
    repo = module.get(getRepositoryToken(MediaFile));
    jest.clearAllMocks();
  });

  describe('saveBuffer', () => {
    it('应落盘并登记元数据，图片解析宽高', async () => {
      const view = await service.saveBuffer('user-1', PNG_1PX, {
        mimeType: 'image/png',
        kind: MediaKind.IMAGE,
        source: MediaSource.GENERATION,
      });

      const saved = repo.save.mock.calls[0][0] as MediaFile;
      expect(saved.userId).toBe('user-1');
      expect(saved.kind).toBe(MediaKind.IMAGE);
      expect(saved.source).toBe(MediaSource.GENERATION);
      expect(saved.fileName).toMatch(/^[0-9a-f-]{36}\.png$/);
      expect(saved.url).toBe(`/uploads/media/${saved.fileName}`);
      expect(saved.bytes).toBe(PNG_1PX.byteLength);
      expect(saved.width).toBe(1);
      expect(saved.height).toBe(1);
      expect(view.url).toContain('/uploads/media/');
    });

    it('未知 MIME 回退 .bin 扩展名', async () => {
      await service.saveBuffer('user-1', Buffer.from('x'), {
        mimeType: 'application/octet-stream',
        kind: MediaKind.FILE,
        source: MediaSource.UPLOAD,
      });
      const saved = repo.save.mock.calls[0][0] as MediaFile;
      expect(saved.fileName).toMatch(/\.bin$/);
    });

    it('应拒绝 SVG 图片（防存储型 XSS）', async () => {
      await expect(
        service.saveBuffer('user-1', Buffer.from('<svg onload="alert(1)"></svg>'), {
          mimeType: 'image/svg+xml',
          kind: MediaKind.IMAGE,
          source: MediaSource.IMPORT,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('图片内容无法被识别时应拒绝（mimetype 可伪造，内容必须真实）', async () => {
      await expect(
        service.saveBuffer('user-1', Buffer.from('<html><script>alert(1)</script></html>'), {
          mimeType: 'image/jpeg',
          kind: MediaKind.IMAGE,
          source: MediaSource.IMPORT,
        }),
      ).rejects.toThrow('图片内容无效');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('声明的 MIME 不在映射表时，应按嗅探结果修正扩展名', async () => {
      await service.saveBuffer('user-1', PNG_1PX, {
        mimeType: 'image/x-unknown',
        kind: MediaKind.IMAGE,
        source: MediaSource.IMPORT,
      });
      const saved = repo.save.mock.calls[0][0] as MediaFile;
      expect(saved.fileName).toMatch(/\.png$/);
    });

    it('数据库登记失败时应清理已写入的文件（避免孤儿文件）', async () => {
      repo.save.mockRejectedValue(new Error('数据库连接断开'));
      await expect(
        service.saveBuffer('user-1', PNG_1PX, {
          mimeType: 'image/png',
          kind: MediaKind.IMAGE,
          source: MediaSource.IMPORT,
        }),
      ).rejects.toThrow('数据库连接断开');
      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveUpload', () => {
    it('图片内容无法被识别时应拒绝并清理落盘文件', async () => {
      const file = {
        mimetype: 'image/png',
        path: '/tmp/upload.png',
        filename: 'uuid.png',
        size: 123,
      } as Express.Multer.File;
      await expect(service.saveUpload('user-1', file)).rejects.toThrow('文件内容不是有效的图片');
      expect(mockUnlink).toHaveBeenCalledWith('/tmp/upload.png');
    });
  });

  describe('findById', () => {
    it('不存在时抛 NotFoundException（中文消息）', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
      await expect(service.findById('missing')).rejects.toThrow('媒体文件 #missing 不存在');
    });
  });

  describe('findByIdsForUser', () => {
    it('空数组直接返回，不查库', async () => {
      const result = await service.findByIdsForUser([], 'user-1');
      expect(result).toEqual([]);
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('部分不存在时报错', async () => {
      repo.find.mockResolvedValue([{ id: 'a', userId: 'user-1' } as MediaFile]);
      await expect(service.findByIdsForUser(['a', 'b'], 'user-1')).rejects.toThrow(
        '媒体文件 #b 不存在',
      );
    });

    it('包含他人文件时拒绝', async () => {
      repo.find.mockResolvedValue([
        { id: 'a', userId: 'user-1' } as MediaFile,
        { id: 'b', userId: 'user-2' } as MediaFile,
      ]);
      await expect(service.findByIdsForUser(['a', 'b'], 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('使用 In() 查询代替已废弃的 findByIds', async () => {
      repo.find.mockResolvedValue([{ id: 'a', userId: 'user-1' } as MediaFile]);
      await service.findByIdsForUser(['a'], 'user-1');
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: expect.anything() } }),
      );
    });
  });
});
