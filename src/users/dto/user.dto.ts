import { ApiProperty } from '@nestjs/swagger';

export class UserDto {
  @ApiProperty({ description: '用户ID', example: 'uuid-string' })
  id: string;

  @ApiProperty({ description: '邮箱', example: 'user@example.com' })
  email: string;

  @ApiProperty({ description: '用户名', example: 'johndoe' })
  username: string;

  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
}