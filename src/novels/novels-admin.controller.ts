import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NovelsService } from './novels.service';
import {
  CreateNovelDto,
  UpdateNovelDto,
  QueryNovelDto,
  CreateChapterDto,
  UpdateChapterDto,
} from './dto';
import { Novel } from './novel.entity';
import { Chapter } from './chapter.entity';

@ApiTags('小说管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/novels')
export class NovelsAdminController {
  constructor(private readonly novelsService: NovelsService) {}

  // ========== 小说管理 ==========

  @Post()
  @ApiOperation({ summary: '创建小说', description: '创建新的小说' })
  @ApiResponse({ status: 201, description: '创建成功', type: Novel })
  @ApiResponse({ status: 401, description: '未授权' })
  async create(@Body() createDto: CreateNovelDto): Promise<Novel> {
    return this.novelsService.create(createDto);
  }

  @Put(':id')
  @ApiOperation({ summary: '更新小说信息' })
  @ApiResponse({ status: 200, description: '更新成功', type: Novel })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '小说不存在' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateNovelDto,
  ): Promise<Novel> {
    return this.novelsService.update(id, updateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除小说', description: '删除小说及其所有章节' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '小说不存在' })
  async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.novelsService.remove(id);
  }

  // ========== 章节管理 ==========

  @Post(':id/chapters')
  @ApiOperation({ summary: '添加章节', description: '为指定小说添加新章节' })
  @ApiResponse({ status: 201, description: '创建成功', type: Chapter })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '小说不存在' })
  @ApiResponse({ status: 409, description: '章节序号已存在' })
  async createChapter(
    @Param('id', ParseIntPipe) id: number,
    @Body() createDto: CreateChapterDto,
  ): Promise<Chapter> {
    return this.novelsService.createChapter(id, createDto);
  }

  @Put(':id/chapters/:chapterId')
  @ApiOperation({ summary: '更新章节' })
  @ApiResponse({ status: 200, description: '更新成功', type: Chapter })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '小说或章节不存在' })
  @ApiResponse({ status: 409, description: '章节序号已存在' })
  async updateChapter(
    @Param('id', ParseIntPipe) id: number,
    @Param('chapterId', ParseIntPipe) chapterId: number,
    @Body() updateDto: UpdateChapterDto,
  ): Promise<Chapter> {
    return this.novelsService.updateChapter(id, chapterId, updateDto);
  }

  @Delete(':id/chapters/:chapterId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除章节' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '小说或章节不存在' })
  async removeChapter(
    @Param('id', ParseIntPipe) id: number,
    @Param('chapterId', ParseIntPipe) chapterId: number,
  ): Promise<void> {
    return this.novelsService.removeChapter(id, chapterId);
  }

  // ========== 封面上传 ==========

  @Post(':id/cover')
  @ApiOperation({ summary: '上传小说封面', description: '上传封面图片并更新小说封面URL' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: '封面图片文件',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: '上传成功', type: Novel })
  @ApiResponse({ status: 400, description: '文件格式错误或文件过大' })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '小说不存在' })
  @UseInterceptors(FileInterceptor('file'))
  async uploadCover(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<Novel> {
    if (!file) {
      throw new BadRequestException('请选择要上传的图片文件');
    }

    // 生成访问 URL
    const coverUrl = `/uploads/covers/${file.filename}`;

    // 更新小说封面
    return this.novelsService.update(id, { coverUrl });
  }
}