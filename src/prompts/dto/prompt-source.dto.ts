import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, IsUrl, Length, Min } from 'class-validator';

export class CreatePromptSourceDto {
  @ApiProperty({ example: '我的提示词库', description: '源名称' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({
    example: 'https://example.com/prompts.json',
    description: '源 JSON 地址（数组格式）',
  })
  @IsUrl({ require_protocol: true }, { message: 'url 必须是合法的 http(s) 地址' })
  @Length(1, 500)
  url: string;

  @ApiProperty({ required: false, example: 'https://example.com', description: '源主页' })
  @IsString()
  @Length(0, 500)
  @IsOptional()
  homepage?: string;
}

export class UpdatePromptSourceDto {
  @ApiProperty({ required: false, description: '源名称' })
  @IsString()
  @Length(1, 100)
  @IsOptional()
  name?: string;

  @ApiProperty({ required: false, description: '源 JSON 地址（数组格式）' })
  @IsUrl({ require_protocol: true }, { message: 'url 必须是合法的 http(s) 地址' })
  @Length(1, 500)
  @IsOptional()
  url?: string;

  @ApiProperty({ required: false, description: '源主页' })
  @IsString()
  @Length(0, 500)
  @IsOptional()
  homepage?: string;

  @ApiProperty({ required: false, description: '是否启用' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({ required: false, description: '排序（越小越靠前）' })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}
