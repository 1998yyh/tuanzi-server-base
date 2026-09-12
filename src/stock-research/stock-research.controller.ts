import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { User } from '../users/users.entity';
import { SendMessageDto } from '../agents/dto/send-message.dto';
import { QueryConversationsDto } from '../agents/dto/query-conversations.dto';
import { classifyStreamError } from '../agents/utils/stream-error';
import { StockResearchService } from './stock-research.service';
import { ResearchWatchService } from './research-watch.service';
import { CreateResearchDto, CreateWatchDto } from './dto/research.dto';
@ApiTags('AI复盘与观察')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stock-research')
export class StockResearchController {
  constructor(
    private readonly research: StockResearchService,
    private readonly watches: ResearchWatchService,
  ) {}
  @Post('conversations')
  @ApiOperation({ summary: '新建AI复盘会话，冻结上下文和证据' })
  @ApiResponse({ status: 201, description: '创建成功' })
  create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateResearchDto) {
    return this.research.create(user.id, dto);
  }
  @Get('conversations')
  @ApiOperation({ summary: '我的复盘会话记录' })
  @ApiResponse({ status: 200, description: '分页会话' })
  list(@CurrentUser() user: Omit<User, 'password'>, @Query() query: QueryConversationsDto) {
    return this.research.list(user.id, query);
  }
  @Get('conversations/:id')
  @ApiOperation({ summary: '复盘会话详情及数据依据' })
  @ApiResponse({ status: 200, description: '会话详情' })
  get(@CurrentUser() user: Omit<User, 'password'>, @Param('id', ParseUUIDPipe) id: string) {
    return this.research.get(user.id, id);
  }
  @Get('conversations/:id/messages')
  @ApiOperation({ summary: '复盘消息历史，最新在前' })
  @ApiResponse({ status: 200, description: '分页消息' })
  messages(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryConversationsDto,
  ) {
    return this.research.messages(user.id, id, query);
  }
  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除本人复盘会话及关联上下文' })
  @ApiResponse({ status: 204, description: '删除成功' })
  remove(@CurrentUser() user: Omit<User, 'password'>, @Param('id', ParseUUIDPipe) id: string) {
    return this.research.remove(user.id, id);
  }
  @Post('conversations/:id/messages')
  @ApiOperation({ summary: '流式复盘对话，始终返回SSE' })
  @ApiResponse({ status: 200, description: 'text_delta/message_end/error事件流' })
  async send(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ) {
    await this.research.prepare(user.id, id);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const abort = new AbortController();
    const close = () => abort.abort();
    res.on('close', close);
    try {
      for await (const event of this.research.stream(user.id, id, dto.content, abort.signal)) {
        if (abort.signal.aborted) break;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const result = classifyStreamError(error);
        res.write(`event: error\ndata: ${JSON.stringify(result)}\n\n`);
      }
    } finally {
      res.removeListener('close', close);
      res.end();
    }
  }
  @Get('watchlist')
  @ApiOperation({ summary: '我的观察池' })
  @ApiResponse({ status: 200, description: '观察记录' })
  watchlist(@CurrentUser() user: Omit<User, 'password'>) {
    return this.watches.list(user.id);
  }
  @Post('watchlist')
  @ApiOperation({ summary: '加入观察池，记录关注理由' })
  @ApiResponse({ status: 201, description: '加入成功' })
  watch(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateWatchDto) {
    return this.watches.create(user.id, dto);
  }
  @Delete('watchlist/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除观察记录，保留独立会话' })
  @ApiResponse({ status: 204, description: '删除成功' })
  unwatch(@CurrentUser() user: Omit<User, 'password'>, @Param('id', ParseUUIDPipe) id: string) {
    return this.watches.remove(user.id, id);
  }
}
