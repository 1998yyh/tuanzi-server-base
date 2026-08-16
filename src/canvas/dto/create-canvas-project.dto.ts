import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CreateCanvasProjectDto {
  @ApiProperty({ example: '我的第一个画布', description: '画布名称' })
  @IsString()
  @Length(1, 200)
  name: string;
}
