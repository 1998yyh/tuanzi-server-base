import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
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

/**
 * 时间侧信道防护用固定哈希：用户不存在时也执行一次 bcrypt 比较，
 * 使「用户不存在」与「密码错误」两条路径耗时一致，防止账号枚举。
 */
const DUMMY_PASSWORD_HASH = '$2b$10$YYo503REnYg5NGfUrz5W3edfSizhrFGPF1/3AZVMcUgYfr7AiOEsq';

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
    const accessTokenTtl = Number(this.configService.get('JWT_EXPIRES_IN') ?? 7200); // 2 小时
    const refreshTokenTtl = Number(this.configService.get('JWT_REFRESH_EXPIRES_IN') ?? 604800); // 7 天
    // fail-fast：非法值（NaN/0/负数）会让所有新签发的 token 无法通过验签，
    // 导致认证整体不可用，必须在启动阶段报错而不是线上 401
    if (!Number.isFinite(accessTokenTtl) || accessTokenTtl <= 0) {
      throw new Error(
        `JWT_EXPIRES_IN 必须是正整数秒数，当前值: ${this.configService.get('JWT_EXPIRES_IN')}`,
      );
    }
    if (!Number.isFinite(refreshTokenTtl) || refreshTokenTtl <= 0) {
      throw new Error(
        `JWT_REFRESH_EXPIRES_IN 必须是正整数秒数，当前值: ${this.configService.get('JWT_REFRESH_EXPIRES_IN')}`,
      );
    }
    this.accessTokenTtl = accessTokenTtl;
    this.refreshTokenTtl = refreshTokenTtl;
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
      // 时间侧信道防护：对固定哈希做一次无意义的 bcrypt 比较，
      // 使「用户不存在」路径耗时与「密码错误」路径一致
      await bcrypt.compare(loginDto.password, DUMMY_PASSWORD_HASH);
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
    let payload: TokenPayload;
    try {
      // 验证 refresh token（仅验签与过期，数据库故障不在此范围）
      payload = this.jwtService.verify<TokenPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('无效的刷新令牌');
    }

    // 只接受 refresh 类型的令牌，防止 access token 被当作 refresh token 使用
    if (payload.type !== TokenType.REFRESH) {
      throw new UnauthorizedException('无效的刷新令牌');
    }

    // 查库与签发移出 try：数据库故障必须原样上抛（500），
    // 不能伪装成 401，否则排障时无法区分令牌无效与数据库宕机
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    // 生成新的 tokens
    return this.generateTokens(user.id);
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
