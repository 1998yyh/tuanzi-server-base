import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { SendMessageDto } from './dto/send-message.dto';

@ApiTags('Agent 会话')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ConversationsController {
  private readonly logger = new Logger(ConversationsController.name);

  constructor(private readonly conversationsService: ConversationsService) {}

  @Post('agents/:agentId/conversations')
  @ApiOperation({ summary: '创建新会话' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 404, description: 'Agent 不存在' })
  @ApiResponse({ status: 410, description: 'Agent 已停用' })
  async createConversation(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversationsService.createConversation(user.id, agentId, dto);
  }

  @Get('agents/:agentId/conversations')
  @ApiOperation({ summary: '会话分页列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: 'Agent 不存在' })
  async listConversations(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Query() query: QueryConversationsDto,
  ) {
    return this.conversationsService.listConversations(user.id, agentId, query);
  }

  @Post('conversations/:id/messages')
  @ApiOperation({
    summary: '发送消息（同步 / SSE 流式）',
    description:
      '默认同步等待 Agent 完整执行；带 ?stream=true 时返回 SSE 事件流（text/event-stream）。' +
      '注意：同一会话必须串行发消息，收到响应（同步 200 或 SSE message_end）前禁止发下一条。',
  })
  @ApiQuery({ name: 'stream', required: false, description: '传 true 走 SSE 流式' })
  @ApiResponse({ status: 201, description: '同步模式：完整消息结果' })
  @ApiResponse({ status: 404, description: '会话不存在' })
  @ApiResponse({ status: 410, description: 'Agent 已停用' })
  async sendMessage(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @Query('stream') stream: string,
    @Res() res: Response,
  ): Promise<void> {
    if (stream === 'true') {
      // SSE 模式：先同步校验（抛错走正常 JSON 错误响应），通过后才发响应头。
      // NestJS @Sse() 仅支持 GET，POST 流式需手动设响应头
      const conversation = await this.conversationsService.prepareStream(user.id, id, dto.content);

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      try {
        for await (const event of this.conversationsService.streamMessages(
          conversation,
          dto.content,
        )) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      } catch (e) {
        // 流式执行中的任意异常：发送 error 事件后关闭流
        this.logger.error(`会话 ${id} 流式执行异常: ${(e as Error).message}`, (e as Error).stack);
        res.write(
          `event: error\ndata: ${JSON.stringify({ message: 'Agent 执行异常，请稍后重试' })}\n\n`,
        );
      }
      res.end();
      return;
    }

    // 同步模式
    const result = await this.conversationsService.sendMessage(user.id, id, dto.content);
    res.status(HttpStatus.CREATED).json(result);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: '获取消息历史（分页）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '会话不存在' })
  async listMessages(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryConversationsDto,
  ) {
    return this.conversationsService.listMessages(user.id, id, query);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除会话', description: '级联删除消息与 LangGraph checkpoint' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '会话不存在' })
  async removeConversation(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.conversationsService.removeConversation(user.id, id);
  }
}
