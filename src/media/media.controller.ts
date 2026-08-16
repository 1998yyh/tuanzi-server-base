import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MediaService } from './media.service';

@ApiTags('媒体文件')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '上传媒体文件', description: '图片/视频/音频，单文件最大 50MB' })
  @ApiResponse({ status: 201, description: '上传成功' })
  @ApiResponse({ status: 400, description: '未选择文件或类型不支持' })
  async upload(
    @CurrentUser() user: Omit<User, 'password'>,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('请选择要上传的文件');
    }
    return this.mediaService.saveUpload(user.id, file);
  }

  @Get(':id')
  @ApiOperation({ summary: '媒体文件元数据' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '媒体文件不存在' })
  async findOne(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const media = await this.mediaService.findById(id);
    // 归属校验：他人媒体一律 404，不泄露存在性（2026-08-15 代码审查）
    if (media.userId !== user.id) {
      throw new NotFoundException(`媒体文件 #${id} 不存在`);
    }
    return this.mediaService.toView(media);
  }
}
