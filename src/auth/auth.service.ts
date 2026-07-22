import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

/** JWT payload 中的令牌类型，用于区分 access / refresh token */
export enum TokenType {
  ACCESS = 'access',
  REFRESH = 'refresh',
}

export interface TokenPayload {
  sub: string;
  type: TokenType;
}

@Injectable()
export class AuthService {
  private readonly accessTokenTtl: number;
  private readonly refreshTokenTtl: number;

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    // 单位：秒。环境变量读出来是字符串，必须显式转数字，
    // 否则 jsonwebtoken 会把 "7200" 当作 7200 毫秒
    this.accessTokenTtl = Number(this.configService.get('JWT_EXPIRES_IN') ?? 7200); // 2 小时
    this.refreshTokenTtl = Number(this.configService.get('JWT_REFRESH_EXPIRES_IN') ?? 604800); // 7 天
  }

  async register(registerDto: RegisterDto) {
    const user = await this.usersService.create(
      registerDto.email,
      registerDto.username,
      registerDto.password,
    );

    return this.generateTokens(user.id);
  }

  async login(loginDto: LoginDto) {
    // 支持邮箱或用户名登录
    const user =
      (await this.usersService.findByEmail(loginDto.login)) ||
      (await this.usersService.findByUsername(loginDto.login));

    // 统一错误文案，避免用户枚举
    if (!user) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    const isValid = await this.usersService.validatePassword(loginDto.password, user.password);

    if (!isValid) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    return this.generateTokens(user.id);
  }

  /**
   * 使用 refresh token 刷新访问令牌
   */
  async refreshByToken(refreshToken: string) {
    try {
      // 验证 refresh token
      const payload = this.jwtService.verify<TokenPayload>(refreshToken);

      // 只接受 refresh 类型的令牌，防止 access token 被当作 refresh token 使用
      if (payload.type !== TokenType.REFRESH) {
        throw new UnauthorizedException('无效的刷新令牌');
      }

      const userId = payload.sub;

      // 检查用户是否存在
      const user = await this.usersService.findById(userId);
      if (!user) {
        throw new UnauthorizedException('用户不存在');
      }

      // 生成新的 tokens
      return this.generateTokens(userId);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('无效的刷新令牌');
    }
  }

  private generateTokens(userId: string) {
    const accessToken = this.jwtService.sign(
      { sub: userId, type: TokenType.ACCESS } satisfies TokenPayload,
      { expiresIn: this.accessTokenTtl },
    );

    const refreshToken = this.jwtService.sign(
      { sub: userId, type: TokenType.REFRESH } satisfies TokenPayload,
      { expiresIn: this.refreshTokenTtl },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTokenTtl,
    };
  }
}
