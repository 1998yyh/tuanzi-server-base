import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { TokenPayload, TokenType } from './auth.service';
import { User } from '../users/users.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    const secret = configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET 未配置，请检查环境变量');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * 验签通过后查库确认用户存在，返回剔除密码的用户信息。
   * 返回值挂载到 req.user，controller 通过 @CurrentUser() 直接获取，无需再次查库。
   */
  async validate(payload: TokenPayload): Promise<Omit<User, 'password'>> {
    // 只接受 access 类型的令牌，防止 refresh token 被当作 access token 使用
    if (payload.type !== TokenType.ACCESS) {
      throw new UnauthorizedException('无效的访问令牌');
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    const { password, ...result } = user;
    return result;
  }
}
