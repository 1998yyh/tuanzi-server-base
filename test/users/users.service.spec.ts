import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from 'src/users/users.service';
import { User, UserRole } from 'src/users/users.entity';

jest.mock('bcrypt');

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<Repository<User>>;

  const mockUser: User = {
    id: 'test-uuid',
    email: 'test@test.com',
    username: 'testuser',
    password: 'hashedPassword',
    role: UserRole.USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    repository = module.get(getRepositoryToken(User));

    jest.clearAllMocks();
  });

  describe('create', () => {
    it('应该加密密码并成功创建用户', async () => {
      repository.findOne.mockResolvedValue(null);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashedPassword');
      repository.create.mockReturnValue(mockUser);
      repository.save.mockResolvedValue(mockUser);

      const result = await service.create('test@test.com', 'testuser', 'password123');

      expect(bcrypt.hash).toHaveBeenCalledWith('password123', 10);
      expect(repository.create).toHaveBeenCalledWith({
        email: 'test@test.com',
        username: 'testuser',
        password: 'hashedPassword',
      });
      expect(result).toEqual(mockUser);
    });

    it('邮箱已存在时应抛出 ConflictException', async () => {
      repository.findOne.mockResolvedValue(mockUser);

      await expect(service.create('test@test.com', 'newuser', 'password123')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.create('test@test.com', 'newuser', 'password123')).rejects.toThrow(
        '邮箱已被注册',
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('用户名已存在时应抛出 ConflictException', async () => {
      // 邮箱查不到、用户名查得到
      repository.findOne.mockImplementation((options) => {
        const where = (options as { where: Record<string, string> }).where;
        return Promise.resolve(where.email ? null : mockUser);
      });

      await expect(service.create('new@test.com', 'testuser', 'password123')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.create('new@test.com', 'testuser', 'password123')).rejects.toThrow(
        '用户名已被使用',
      );
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('findByEmail / findByUsername / findById', () => {
    it('findByEmail 应按邮箱查询', async () => {
      repository.findOne.mockResolvedValue(mockUser);

      const result = await service.findByEmail('test@test.com');

      expect(repository.findOne).toHaveBeenCalledWith({ where: { email: 'test@test.com' } });
      expect(result).toEqual(mockUser);
    });

    it('findByUsername 应按用户名查询', async () => {
      repository.findOne.mockResolvedValue(mockUser);

      const result = await service.findByUsername('testuser');

      expect(repository.findOne).toHaveBeenCalledWith({ where: { username: 'testuser' } });
      expect(result).toEqual(mockUser);
    });

    it('findById 应按 ID 查询，不存在时返回 null', async () => {
      repository.findOne.mockResolvedValue(null);

      const result = await service.findById('nonexistent');

      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'nonexistent' } });
      expect(result).toBeNull();
    });
  });

  describe('validatePassword', () => {
    it('密码匹配时应返回 true', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.validatePassword('password123', 'hashedPassword');

      expect(bcrypt.compare).toHaveBeenCalledWith('password123', 'hashedPassword');
      expect(result).toBe(true);
    });

    it('密码不匹配时应返回 false', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const result = await service.validatePassword('wrongPassword', 'hashedPassword');

      expect(result).toBe(false);
    });
  });
});
