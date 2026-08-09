import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PromptsService } from './prompts.service';
import { CreatePromptSourceDto, UpdatePromptSourceDto } from './dto/prompt-source.dto';
import { QueryPromptsDto } from './dto/query-prompts.dto';

@ApiTags('提示词库')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('prompts')
export class PromptsController {
  constructor(private readonly promptsService: PromptsService) {}

  @Get()
  @ApiOperation({ summary: '提示词列表（关键词/标签/分类过滤 + 分页）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async fetchPrompts(@CurrentUser() user: Omit<User, 'password'>, @Query() query: QueryPromptsDto) {
    return this.promptsService.fetchPrompts(user, query);
  }

  @Get('sources')
  @ApiOperation({ summary: '提示词源列表（内置 + 自建）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async listSources(@CurrentUser() user: Omit<User, 'password'>) {
    return this.promptsService.listSources(user);
  }

  @Post('sources')
  @ApiOperation({ summary: '新建自建提示词源' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async createSource(
    @CurrentUser() user: Omit<User, 'password'>,
    @Body() dto: CreatePromptSourceDto,
  ) {
    return this.promptsService.createSource(user, dto);
  }

  @Patch('sources/:id')
  @ApiOperation({ summary: '更新提示词源', description: '内置源只能切换启用状态' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '源不存在' })
  async updateSource(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromptSourceDto,
  ) {
    return this.promptsService.updateSource(user, id, dto);
  }

  @Delete('sources/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除自建提示词源' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '源不存在' })
  async removeSource(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.promptsService.removeSource(user, id);
  }

  @Get('sources/statuses')
  @ApiOperation({ summary: '各源抓取状态（条数/最近成功时间/最近错误）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async fetchSourceStatuses(@CurrentUser() user: Omit<User, 'password'>) {
    return this.promptsService.fetchSourceStatuses(user);
  }

  @Get('sources/:id/items')
  @ApiOperation({ summary: '单个源的全部提示词' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async fetchSourcePrompts(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.promptsService.fetchSourcePrompts(user, id);
  }

  @Post('sources/:id/refresh')
  @ApiOperation({ summary: '强制刷新单个源（绕过缓存）' })
  @ApiResponse({ status: 200, description: '刷新成功' })
  @ApiResponse({ status: 400, description: '抓取失败' })
  async refreshSource(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.promptsService.refreshSource(user, id);
  }

  @Post('refresh-all')
  @ApiOperation({ summary: '刷新所有启用的源' })
  @ApiResponse({ status: 200, description: '刷新完成（含各源成败明细）' })
  async refreshAllSources(@CurrentUser() user: Omit<User, 'password'>) {
    return this.promptsService.refreshAllSources(user);
  }
}
