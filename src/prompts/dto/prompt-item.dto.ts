import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreatePromptDto {
  @ApiProperty({ description: '标题', example: '产品宣传海报' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title: string;

  @ApiProperty({ description: '提示词正文', example: '绘制一张极简产品海报' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  prompt: string;

  @ApiProperty({ description: '描述', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @ApiProperty({ description: '用途分类，可填写自定义分类', example: '海报广告', required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^(?!all$).+$/u, { message: '分类不能使用保留名称 all' })
  category?: string;

  @ApiProperty({ description: '标签', example: ['极简', '产品'], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];

  @ApiProperty({ description: '封面图片地址，支持 /uploads/ 本地地址', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(/^(?:$|https?:\/\/|\/uploads\/)/i, { message: '封面必须是 http(s) 或本地上传地址' })
  coverUrl?: string;

  @ApiProperty({ description: '参考图片地址', required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  @Matches(/^(?:https?:\/\/|\/uploads\/)/i, {
    each: true,
    message: '参考图必须是 http(s) 或本地上传地址',
  })
  referenceImageUrls?: string[];

  @ApiProperty({ description: '图像模式', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  imageMode?: string;

  @ApiProperty({ description: '图像模型', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  imageModel?: string;

  @ApiProperty({ description: '图片尺寸', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  imageSize?: string;

  @ApiProperty({ description: '图片数量', required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  imageCount?: number;
}

export class UpdatePromptDto extends PartialType(CreatePromptDto, { skipNullProperties: false }) {}
