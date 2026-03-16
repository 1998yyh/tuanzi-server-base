import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let jwtService: jest.Mocked<JwtService>;

  const mockUser = {
    id: 'test-uuid',
    email: 'test@test.com',
    username: 'testuser',
    password: 'hashedPassword',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockUsersService = {
      create: jest.fn(),
      findByEmail: jest.fn(),
      findByUsername: jest.fn(),
      findById: jest.fn(),
      validatePassword: jest.fn(),
    };

    const mockJwtService = {
      sign: jest.fn(),
      verify: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    usersService = module.get(UsersService);
    jwtService = module.get(JwtService);
  });

  describe('register', () => {
    it('应该成功注册新用户并返回 tokens', async () => {
      const registerDto: RegisterDto = {
        email: 'test@test.com',
        username: 'testuser',
        password: 'password123',
      };

      usersService.create.mockResolvedValue(mockUser);
      jwtService.sign.mockReturnValueOnce('accessToken').mockReturnValueOnce('refreshToken');

      const result = await service.register(registerDto);

      expect(usersService.create).toHaveBeenCalledWith(
        registerDto.email,
        registerDto.username,
        registerDto.password,
      );
      expect(result).toEqual({
        accessToken: 'accessToken',
        refreshToken: 'refreshToken',
        expiresIn: 7200,
      });
    });
  });

  describe('login', () => {
    const loginDto: LoginDto = {
      login: 'test@test.com',
      password: 'password123',
    };

    it('应该用邮箱成功登录', async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      usersService.validatePassword.mockResolvedValue(true);
      jwtService.sign.mockReturnValueOnce('accessToken').mockReturnValueOnce('refreshToken');

      const result = await service.login(loginDto);

      expect(usersService.findByEmail).toHaveBeenCalledWith(loginDto.login);
      expect(result).toEqual({
        accessToken: 'accessToken',
        refreshToken: 'refreshToken',
        expiresIn: 7200,
      });
    });

    it('应该用用户名成功登录', async () => {
      const loginWithUsername = { ...loginDto, login: 'testuser' };
      usersService.findByEmail.mockResolvedValue(null);
      usersService.findByUsername.mockResolvedValue(mockUser);
      usersService.validatePassword.mockResolvedValue(true);
      jwtService.sign.mockReturnValueOnce('accessToken').mockReturnValueOnce('refreshToken');

      const result = await service.login(loginWithUsername);

      expect(usersService.findByUsername).toHaveBeenCalledWith('testuser');
      expect(result.accessToken).toBe('accessToken');
    });

    it('用户不存在时应抛出 UnauthorizedException', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.findByUsername.mockResolvedValue(null);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
      await expect(service.login(loginDto)).rejects.toThrow('用户不存在');
    });

    it('密码错误时应抛出 UnauthorizedException', async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      usersService.validatePassword.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
      await expect(service.login(loginDto)).rejects.toThrow('密码错误');
    });
  });

  describe('getProfile', () => {
    it('应该返回用户信息（不含密码）', async () => {
      usersService.findById.mockResolvedValue(mockUser);

      const result = await service.getProfile('test-uuid');

      expect(result).toEqual({
        id: mockUser.id,
        email: mockUser.email,
        username: mockUser.username,
        createdAt: mockUser.createdAt,
        updatedAt: mockUser.updatedAt,
      });
      expect(result).not.toHaveProperty('password');
    });

    it('用户不存在时应抛出 UnauthorizedException', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(service.getProfile('nonexistent')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refreshByToken', () => {
    it('应该用有效的 refresh token 刷新 tokens', async () => {
      jwtService.verify.mockReturnValue({ sub: 'test-uuid' });
      usersService.findById.mockResolvedValue(mockUser);
      jwtService.sign.mockReturnValueOnce('newAccessToken').mockReturnValueOnce('newRefreshToken');

      const result = await service.refreshByToken('validRefreshToken');

      expect(jwtService.verify).toHaveBeenCalledWith('validRefreshToken');
      expect(result).toEqual({
        accessToken: 'newAccessToken',
        refreshToken: 'newRefreshToken',
        expiresIn: 7200,
      });
    });

    it('无效的 refresh token 应抛出 UnauthorizedException', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await expect(service.refreshByToken('invalidToken')).rejects.toThrow(UnauthorizedException);
      await expect(service.refreshByToken('invalidToken')).rejects.toThrow('无效的刷新令牌');
    });

    it('用户不存在时应抛出 UnauthorizedException', async () => {
      jwtService.verify.mockReturnValue({ sub: 'test-uuid' });
      usersService.findById.mockResolvedValue(null);

      await expect(service.refreshByToken('validRefreshToken')).rejects.toThrow(UnauthorizedException);
    });
  });
});