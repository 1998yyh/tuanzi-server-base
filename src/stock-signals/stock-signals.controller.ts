import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { StockSignalsService } from './stock-signals.service';
import { CreateScanDto } from './dto/create-scan.dto';

@ApiTags('Stock Signals')
@Controller('stock-signals')
export class StockSignalsController {
  constructor(private readonly stockSignalsService: StockSignalsService) {}

  @Post('scans')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '发起扫描',
    description:
      '全市场：该日期已有缓存且非强制刷新直接返回缓存任务，否则建异步任务（轮询 GET /scans/:id）；' +
      '指定 codes：同步抓取并落库后返回 B 列表',
  })
  @ApiResponse({ status: 201, description: '任务已创建或命中缓存' })
  @ApiResponse({ status: 400, description: '日期非法或 codes 超限' })
  @ApiResponse({ status: 401, description: '未授权' })
  async requestScan(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateScanDto) {
    return this.stockSignalsService.requestScan(user, dto);
  }

  @Get('scans/:id')
  @ApiOperation({ summary: '扫描任务状态（轮询），done 时附 B 列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  async getRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.stockSignalsService.getRun(id);
  }

  @Get()
  @ApiOperation({ summary: '某日 B 信号结果（取该日期最新一次完成的扫描）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: 'date 格式非法' })
  @ApiResponse({ status: 404, description: '该日期尚未扫描' })
  async getByDate(@Query('date') date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
      throw new BadRequestException('date 必须为 YYYY-MM-DD 格式');
    }
    return this.stockSignalsService.getByDate(date);
  }

  @Get('dates')
  @ApiOperation({ summary: '历史日期列表（已完成扫描的日期，最新在前）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getDates() {
    return this.stockSignalsService.getDates();
  }
}
