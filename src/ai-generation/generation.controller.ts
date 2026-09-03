import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GenerationService } from './generation.service';
import { GenerateImageDto } from './dto/generate-image.dto';
import { GenerateVideoDto } from './dto/generate-video.dto';
import { GenerateAudioDto } from './dto/generate-audio.dto';
import { QueryGenerationTasksDto } from './dto/query-generation-tasks.dto';

@ApiTags('AI 生成')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai-generation')
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  @Post('images')
  @ApiOperation({
    summary: '图片生成（同步）',
    description: '文生图 / 参考图编辑；结果落盘为媒体文件，响应只含 URL',
  })
  @ApiResponse({ status: 201, description: '生成成功' })
  @ApiResponse({ status: 400, description: '参数错误或生成失败' })
  async generateImage(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: GenerateImageDto) {
    return this.generationService.generateImage(user, dto);
  }

  @Post('videos')
  @ApiOperation({
    summary: '视频生成（异步）',
    description:
      '立即返回任务（pending/processing），由后端轮询远端任务并回填结果；前端轮询 GET /tasks/:id',
  })
  @ApiResponse({ status: 201, description: '任务创建成功' })
  @ApiResponse({ status: 400, description: '参数错误或任务创建失败' })
  async generateVideo(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: GenerateVideoDto) {
    return this.generationService.generateVideo(user, dto);
  }

  @Post('audios')
  @ApiOperation({
    summary: '音频生成（同步）',
    description: '语音合成；结果落盘为媒体文件，响应只含 URL',
  })
  @ApiResponse({ status: 201, description: '生成成功' })
  @ApiResponse({ status: 400, description: '参数错误或生成失败' })
  async generateAudio(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: GenerateAudioDto) {
    return this.generationService.generateAudio(user, dto);
  }

  @Get('tasks')
  @ApiOperation({ summary: '生成任务历史（分页）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findTasks(
    @CurrentUser() user: Omit<User, 'password'>,
    @Query() query: QueryGenerationTasksDto,
  ) {
    return this.generationService.findTasks(user, query);
  }

  @Get('tasks/:id')
  @ApiOperation({ summary: '生成任务详情', description: '前端轮询生成中任务用' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  async findTask(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.generationService.findTask(user, id);
  }

  @Post('tasks/:id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '删除生成任务',
    description:
      '只删任务记录，不删结果媒体（素材库/画布可能仍引用）。进行中的视频任务删掉后轮询不再处理。',
  })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 403, description: '不是自己的任务' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  async removeTask(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.generationService.removeTask(user, id);
  }
}
