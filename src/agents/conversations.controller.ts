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
import { classifyStreamError } from './utils/stream-error';

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
      const conversation = await this.conversationsService.prepareStream(user.id, id);

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      // 禁 nginx proxy_buffering：不设此头时事件会被反向代理攒批，
      // 前端观感是「卡住半天一股脑全来」而非逐条流式
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // SSE 心跳：每 15s 一个注释帧（: 开头，客户端解析器自动忽略）。
      // Agent 长思考/工具调用期间无任何字节流出，反向代理 proxy_read_timeout 会掐断静默连接
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          // 连接已关闭，finally 统一清理定时器
        }
      }, 15000);
      heartbeat.unref();

      // 客户端断开（close 事件）时中止底层 LangGraph 执行，
      // 避免断线后 LLM 调用 / 工具副作用仍在后台空跑
      const abortController = new AbortController();
      const onClose = () => abortController.abort();
      res.on('close', onClose);

      try {
        for await (const event of this.conversationsService.streamMessages(
          conversation,
          dto.content,
          { signal: abortController.signal },
        )) {
          // 断线中止后不再向已关闭的响应写数据
          if (abortController.signal.aborted) break;
          try {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
          } catch (writeErr) {
            // 响应已关闭（客户端断线）时 res.write 可能抛错：停止写入，交由 close 路径收尾
            this.logger.warn(
              `会话 ${id} 响应写入失败，停止 SSE 推送: ${(writeErr as Error).message}`,
            );
            break;
          }
        }
      } catch (e) {
        if (abortController.signal.aborted) {
          // 断线中止导致的异常：客户端已不在，无需（也无法）发送 error 事件
          this.logger.warn(`会话 ${id} 客户端断开，已中止流式执行`);
        } else {
          // 流式执行中的任意异常：响应头已 flush、状态码无法再改，只能以 SSE error 事件透出。
          // 完整原文进服务端日志；前端只拿到分类 code + 固定中文文案（不外泄上游细节）。
          this.logger.error(`会话 ${id} 流式执行异常: ${(e as Error).message}`, (e as Error).stack);
          const { code, message } = classifyStreamError(e);
          try {
            res.write(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`);
          } catch {
            // 响应已关闭则放弃发送 error 事件
          }
        }
      } finally {
        clearInterval(heartbeat);
        res.removeListener('close', onClose);
        res.end();
      }
      return;
    }

    // 同步模式
    const result = await this.conversationsService.sendMessage(user.id, id, dto.content);
    res.status(HttpStatus.CREATED).json(result);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: '获取消息历史（倒序分页，最新在前）' })
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
