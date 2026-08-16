import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../../users/users.entity';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ConversationsService } from '../conversations.service';
import { BackgroundTasksService } from './background-tasks.service';

@ApiTags('Agent 后台任务')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class BackgroundTasksController {
  constructor(
    private readonly backgroundTasksService: BackgroundTasksService,
    private readonly conversationsService: ConversationsService,
  ) {}

  @Get(':id/background-tasks')
  @ApiOperation({ summary: '会话的后台任务列表（最新在前，供前端头部 pill 轮询）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '会话不存在' })
  async list(@CurrentUser() user: Omit<User, 'password'>, @Param('id', ParseUUIDPipe) id: string) {
    // 归属校验复用会话服务的统一入口（查不到/别人的一律 404）
    await this.conversationsService.assertOwnedConversation(user.id, id);
    return this.backgroundTasksService.listByConversation(id);
  }
}
