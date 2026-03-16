import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

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
    const user = await this.usersService.findByEmail(loginDto.login) ||
                 await this.usersService.findByUsername(loginDto.login);

    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    const isValid = await this.usersService.validatePassword(
      loginDto.password,
      user.password,
    );

    if (!isValid) {
      throw new UnauthorizedException('密码错误');
    }

    return this.generateTokens(user.id);
  }

  async getProfile(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    const { password, ...result } = user;
    return result;
  }

  /**
   * 使用 refresh token 刷新访问令牌
   */
  async refreshByToken(refreshToken: string) {
    try {
      // 验证 refresh token
      const payload = this.jwtService.verify(refreshToken);
      const userId = payload.sub;

      // 检查用户是否存在
      const user = await this.usersService.findById(userId);
      if (!user) {
        throw new UnauthorizedException('用户不存在');
      }

      // 生成新的 tokens
      return this.generateTokens(userId);
    } catch (error) {
      throw new UnauthorizedException('无效的刷新令牌');
    }
  }

  private generateTokens(userId: string) {
    const payload = { sub: userId };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: '2h',
    });

    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: '7d',
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 7200, // 2小时（秒）
    };
  }
}