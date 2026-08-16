import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  /**
   * 统一鉴权失败文案（token 缺失/过期/验签失败时 passport 默认抛英文 "Unauthorized"，
   * 与全站中文错误约定不一致，这里统一转成中文）。
   */
  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw err instanceof UnauthorizedException
        ? err
        : new UnauthorizedException('登录状态已失效，请重新登录');
    }
    return user;
  }
}
