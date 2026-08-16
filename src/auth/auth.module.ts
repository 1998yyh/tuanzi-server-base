import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret) {
          throw new Error('JWT_SECRET 未配置，请检查环境变量');
        }
        // 环境变量是字符串，需转数字（秒）；非法值 fail-fast，避免 token 全部无法验签
        const expiresIn = Number(configService.get('JWT_EXPIRES_IN') ?? 7200);
        if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
          throw new Error(
            `JWT_EXPIRES_IN 必须是正整数秒数，当前值: ${configService.get('JWT_EXPIRES_IN')}`,
          );
        }
        return {
          secret,
          signOptions: {
            expiresIn,
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
