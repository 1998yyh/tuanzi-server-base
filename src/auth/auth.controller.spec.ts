import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

describe('AuthController', () => {
  let controller: AuthController;
  let service: jest.Mocked<AuthService>;

  const mockAuthResponse = {
    accessToken: 'testAccessToken',
    refreshToken: 'testRefreshToken',
    expiresIn: 7200,
  };

  const mockUser = {
    id: 'test-uuid',
    email: 'test@test.com',
    username: 'testuser',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockService = {
      register: jest.fn(),
      login: jest.fn(),
      getProfile: jest.fn(),
      refreshByToken: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    service = module.get(AuthService);
  });

  describe('register', () => {
    it('应该成功注册并返回 tokens', async () => {
      const registerDto: RegisterDto = {
        email: 'test@test.com',
        username: 'testuser',
        password: 'password123',
      };

      service.register.mockResolvedValue(mockAuthResponse);

      const result = await controller.register(registerDto);

      expect(service.register).toHaveBeenCalledWith(registerDto);
      expect(result).toEqual(mockAuthResponse);
    });
  });

  describe('login', () => {
    it('应该成功登录并返回 tokens', async () => {
      const loginDto: LoginDto = {
        login: 'test@test.com',
        password: 'password123',
      };

      service.login.mockResolvedValue(mockAuthResponse);

      const result = await controller.login(loginDto);

      expect(service.login).toHaveBeenCalledWith(loginDto);
      expect(result).toEqual(mockAuthResponse);
    });
  });

  describe('getProfile', () => {
    it('应该返回当前用户信息', async () => {
      const req = { user: { userId: 'test-uuid' } };

      service.getProfile.mockResolvedValue(mockUser);

      const result = await controller.getProfile(req);

      expect(service.getProfile).toHaveBeenCalledWith('test-uuid');
      expect(result).toEqual(mockUser);
    });
  });

  describe('refresh', () => {
    it('应该使用 refresh token 刷新并返回新 tokens', async () => {
      const refreshTokenDto: RefreshTokenDto = {
        refreshToken: 'validRefreshToken',
      };

      service.refreshByToken.mockResolvedValue(mockAuthResponse);

      const result = await controller.refresh(refreshTokenDto);

      expect(service.refreshByToken).toHaveBeenCalledWith('validRefreshToken');
      expect(result).toEqual(mockAuthResponse);
    });
  });
});