import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from 'src/auth/jwt.strategy';
import { UsersService } from 'src/users/users.service';
import { TokenType } from 'src/auth/auth.service';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let usersService: jest.Mocked<UsersService>;

  const mockUser = {
    id: 'test-uuid',
    email: 'test@test.com',
    username: 'testuser',
    password: 'hashedPassword',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createStrategy = (secret?: string) => {
    const configService = {
      get: jest.fn().mockReturnValue(secret),
    } as unknown as ConfigService;

    usersService = {
      findById: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;

    return new JwtStrategy(configService, usersService);
  };

  describe('constructor', () => {
    it('JWT_SECRET 已配置时应正常实例化', () => {
      strategy = createStrategy('test-secret');
      expect(strategy).toBeDefined();
    });

    it('JWT_SECRET 未配置时应直接抛错（fail fast）', () => {
      expect(() => createStrategy(undefined)).toThrow('JWT_SECRET 未配置');
    });
  });

  describe('validate', () => {
    beforeEach(() => {
      strategy = createStrategy('test-secret');
    });

    it('应该返回剔除密码的用户信息', async () => {
      usersService.findById.mockResolvedValue(mockUser);

      const result = await strategy.validate({ sub: 'test-uuid', type: TokenType.ACCESS });

      expect(usersService.findById).toHaveBeenCalledWith('test-uuid');
      expect(result).toEqual({
        id: mockUser.id,
        email: mockUser.email,
        username: mockUser.username,
        createdAt: mockUser.createdAt,
        updatedAt: mockUser.updatedAt,
      });
      expect(result).not.toHaveProperty('password');
    });

    it('refresh token 不能当作 access token 使用', async () => {
      await expect(
        strategy.validate({ sub: 'test-uuid', type: TokenType.REFRESH }),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersService.findById).not.toHaveBeenCalled();
    });

    it('缺少 type 标记的 token 应被拒绝', async () => {
      await expect(
        strategy.validate({ sub: 'test-uuid' } as Parameters<JwtStrategy['validate']>[0]),
      ).rejects.toThrow('无效的访问令牌');
    });

    it('用户不存在时应抛出 UnauthorizedException', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(
        strategy.validate({ sub: 'nonexistent', type: TokenType.ACCESS }),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        strategy.validate({ sub: 'nonexistent', type: TokenType.ACCESS }),
      ).rejects.toThrow('用户不存在');
    });
  });
});
