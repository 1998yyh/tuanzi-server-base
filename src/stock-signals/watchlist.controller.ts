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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WatchlistService } from './watchlist.service';
import { AddWatchlistItemsDto } from './dto/add-watchlist-items.dto';

@ApiTags('Stock Watchlist')
@Controller('stock-watchlist')
export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '我的观察池（triggered 排前，其余按创建时间倒序）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 401, description: '未授权' })
  async list(@CurrentUser() user: Omit<User, 'password'>) {
    return { items: await this.watchlistService.list(user.id) };
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '批量入池',
    description:
      '逐条校验（非法代码剔除）、去重、容量截断（单用户 100 只）；入池后即时做 S 判定，' +
      '响应含 added/invalid/duplicated/overflow 四类结果与入池后的完整池子',
  })
  @ApiResponse({ status: 201, description: '处理完成（部分条目可能被剔除，见响应分类）' })
  @ApiResponse({ status: 400, description: '请求体非法' })
  @ApiResponse({ status: 401, description: '未授权' })
  async add(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: AddWatchlistItemsDto) {
    return this.watchlistService.addItems(user.id, dto.items);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除观察池条目', description: '只能删自己的，他人 id 按 404 处理' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '条目不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.watchlistService.remove(user.id, id);
  }

  @Post('check')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '手动立即检查',
    description: '强制刷新池内全部代码当日信号（codes 模式），再对 watching 项跑 S 评估',
  })
  @ApiResponse({ status: 200, description: '检查完成，返回刷新数/新触发数与完整池子' })
  @ApiResponse({ status: 401, description: '未授权' })
  async check(@CurrentUser() user: Omit<User, 'password'>) {
    return this.watchlistService.check(user.id);
  }
}
