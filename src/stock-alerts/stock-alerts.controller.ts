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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { User } from '../users/users.entity';
import {
  CreateStockAlertDto,
  QueryStockAlertsDto,
  UpdateStockAlertDto,
} from './dto/stock-alert.dto';
import { StockAlertsService } from './stock-alerts.service';

@ApiTags('股票提醒')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stock-research')
export class StockAlertsController {
  constructor(private readonly service: StockAlertsService) {}

  @Get('alerts')
  @ApiOperation({ summary: '分页查看我的股票提醒' })
  @ApiResponse({ status: 200, description: '只返回当前用户的提醒' })
  list(@CurrentUser() user: Omit<User, 'password'>, @Query() query: QueryStockAlertsDto) {
    return this.service.list(user.id, query.page, query.limit);
  }

  @Post('alerts')
  @ApiOperation({ summary: '创建价格、涨跌幅或日线 MACD 提醒' })
  @ApiResponse({ status: 201, description: '提醒创建成功' })
  create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateStockAlertDto) {
    return this.service.create(user.id, dto);
  }

  @Patch('alerts/:id')
  @ApiOperation({ summary: '启用或停用我的提醒' })
  @ApiResponse({ status: 200, description: '提醒状态更新成功' })
  @ApiResponse({ status: 404, description: '提醒不存在' })
  update(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStockAlertDto,
  ) {
    return this.service.update(user.id, id, dto);
  }

  @Delete('alerts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除我的提醒' })
  @ApiResponse({ status: 204, description: '提醒删除成功' })
  @ApiResponse({ status: 404, description: '提醒不存在' })
  remove(@CurrentUser() user: Omit<User, 'password'>, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(user.id, id);
  }

  @Get('alert-events')
  @ApiOperation({ summary: '分页查看我的提醒事件' })
  @ApiResponse({ status: 200, description: '只返回当前用户的事件' })
  listEvents(@CurrentUser() user: Omit<User, 'password'>, @Query() query: QueryStockAlertsDto) {
    return this.service.listEvents(user.id, query.page, query.limit);
  }

  @Post('alert-events/:id/read')
  @ApiOperation({ summary: '将我的提醒事件标记为已读（幂等）' })
  @ApiResponse({ status: 201, description: '返回事件当前已读状态' })
  @ApiResponse({ status: 404, description: '提醒事件不存在' })
  markRead(@CurrentUser() user: Omit<User, 'password'>, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.markRead(user.id, id);
  }
}
