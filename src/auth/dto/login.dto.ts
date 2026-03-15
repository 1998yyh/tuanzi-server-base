import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ description: '邮箱或用户名', example: 'user@example.com' })
  @IsString()
  login: string;

  @ApiProperty({ description: '密码', example: 'Password123!' })
  @IsString()
  @MinLength(1)
  password: string;
}