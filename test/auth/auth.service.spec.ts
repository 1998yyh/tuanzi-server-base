import { Test, TestingModule } from '@nestjs/testing';
import { AuthService, TokenType } from 'src/auth/auth.service';
import { UsersService } from 'src/users/users.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { RegisterDto } from 'src/auth/dto/register.dto';
import { LoginDto } from 'src/auth/dto/login.dto';

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

  const mockConfig: Record<string, string> = {
    JWT_EXPIRES_IN: '7200',
    JWT_REFRESH_EXPIRES_IN: '604800',
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

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: unknown) => mockConfig[key] ?? defaultValue),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
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

    it('用户不存在时应抛出统一的认证错误（防止用户枚举）', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.findByUsername.mockResolvedValue(null);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
      await expect(service.login(loginDto)).rejects.toThrow('用户名或密码错误');
    });

    it('密码错误时应抛出统一的认证错误（防止用户枚举）', async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      usersService.validatePassword.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
      await expect(service.login(loginDto)).rejects.toThrow('用户名或密码错误');
    });
  });

  describe('generateTokens（通过 login 间接验证）', () => {
    it('access token 与 refresh token 应携带不同的 type 标记', async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      usersService.validatePassword.mockResolvedValue(true);
      jwtService.sign.mockReturnValue('token');

      await service.login({ login: 'test@test.com', password: 'password123' });

      expect(jwtService.sign).toHaveBeenNthCalledWith(
        1,
        { sub: mockUser.id, type: TokenType.ACCESS },
        { expiresIn: 7200 },
      );
      expect(jwtService.sign).toHaveBeenNthCalledWith(
        2,
        { sub: mockUser.id, type: TokenType.REFRESH },
        { expiresIn: 604800 },
      );
    });
  });

  describe('refreshByToken', () => {
    it('应该用有效的 refresh token 刷新 tokens', async () => {
      jwtService.verify.mockReturnValue({ sub: 'test-uuid', type: TokenType.REFRESH });
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

    it('access token 不能当作 refresh token 使用', async () => {
      jwtService.verify.mockReturnValue({ sub: 'test-uuid', type: TokenType.ACCESS });

      await expect(service.refreshByToken('accessToken')).rejects.toThrow(UnauthorizedException);
      await expect(service.refreshByToken('accessToken')).rejects.toThrow('无效的刷新令牌');
      expect(usersService.findById).not.toHaveBeenCalled();
    });

    it('缺少 type 标记的旧格式 token 应被拒绝', async () => {
      jwtService.verify.mockReturnValue({ sub: 'test-uuid' });

      await expect(service.refreshByToken('legacyToken')).rejects.toThrow('无效的刷新令牌');
    });

    it('签名无效的 refresh token 应抛出 UnauthorizedException', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await expect(service.refreshByToken('invalidToken')).rejects.toThrow(UnauthorizedException);
      await expect(service.refreshByToken('invalidToken')).rejects.toThrow('无效的刷新令牌');
    });

    it('用户不存在时应抛出 UnauthorizedException', async () => {
      jwtService.verify.mockReturnValue({ sub: 'test-uuid', type: TokenType.REFRESH });
      usersService.findById.mockResolvedValue(null);

      await expect(service.refreshByToken('validRefreshToken')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
