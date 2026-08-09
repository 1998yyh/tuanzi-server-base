import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsService } from 'src/assets/assets.service';
import { Asset, AssetKind } from 'src/assets/asset.entity';
import { MediaService } from 'src/media/media.service';
import { MediaKind, MediaSource } from 'src/media/media-file.entity';

const user = { id: 'user-1' } as never;

describe('AssetsService', () => {
  let service: AssetsService;
  let assetRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mediaService: { findByIdsForUser: jest.Mock; saveBuffer: jest.Mock; toView: jest.Mock };

  const mockFetch = jest.fn();

  beforeEach(async () => {
    global.fetch = mockFetch as never;
    mockFetch.mockReset();
    assetRepo = {
      create: jest.fn((v) => ({ id: 'asset-1', ...v })),
      save: jest.fn(async (v) => v),
      findOne: jest.fn(),
      remove: jest.fn(async () => undefined),
      createQueryBuilder: jest.fn(),
    };
    mediaService = {
      findByIdsForUser: jest.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, kind: MediaKind.IMAGE })),
      ),
      saveBuffer: jest.fn(async () => ({ id: 'media-1', url: '/uploads/media/x.png' })),
      toView: jest.fn((m) => m),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssetsService,
        { provide: getRepositoryToken(Asset), useValue: assetRepo },
        { provide: MediaService, useValue: mediaService },
      ],
    }).compile();
    service = module.get(AssetsService);
  });

  describe('create', () => {
    it('文本素材必须有内容', async () => {
      await expect(service.create(user, { kind: AssetKind.TEXT, title: 't' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('图片素材必须提供属于自己的 mediaId', async () => {
      await expect(service.create(user, { kind: AssetKind.IMAGE, title: 't' })).rejects.toThrow(
        'mediaId',
      );
      mediaService.findByIdsForUser.mockResolvedValue([]);
      await expect(
        service.create(user, { kind: AssetKind.IMAGE, title: 't', mediaId: 'media-x' }),
      ).rejects.toThrow('不属于当前用户');
    });

    it('文本素材入库并返回视图', async () => {
      assetRepo.findOne.mockResolvedValue({
        id: 'asset-1',
        userId: 'user-1',
        kind: AssetKind.TEXT,
        title: '提示词',
        textContent: '一只猫',
        media: null,
      });
      const view = await service.create(user, {
        kind: AssetKind.TEXT,
        title: '提示词',
        textContent: '一只猫',
      });
      expect(view.id).toBe('asset-1');
      expect(assetRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ kind: AssetKind.TEXT, textContent: '一只猫', mediaId: null }),
      );
    });
  });

  describe('addImageFromUrl', () => {
    it('dataURL 直接解码落盘', async () => {
      assetRepo.findOne.mockResolvedValue({ id: 'asset-1', media: null });
      await service.addImageFromUrl(user, {
        title: '图',
        imageUrl: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
      });
      expect(mediaService.saveBuffer).toHaveBeenCalledWith(
        'user-1',
        Buffer.from('png-bytes'),
        expect.objectContaining({ kind: MediaKind.IMAGE, source: MediaSource.IMPORT }),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('远程 URL 下载落盘，非图片内容报错', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new ArrayBuffer(8),
      });
      await expect(
        service.addImageFromUrl(user, { title: '图', imageUrl: 'https://a.com/x' }),
      ).rejects.toThrow('不是图片');
    });

    it('非法地址报错', async () => {
      await expect(
        service.addImageFromUrl(user, { title: '图', imageUrl: 'ftp://a.com/x.png' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    it('素材不存在时报 404', async () => {
      assetRepo.findOne.mockResolvedValue(null);
      await expect(service.remove(user, 'missing')).rejects.toThrow(NotFoundException);
    });
  });
});
