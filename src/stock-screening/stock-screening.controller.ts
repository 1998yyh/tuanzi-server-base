import {
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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { User } from '../users/users.entity';
import { CreateScreeningRunDto, ScreeningRunsQueryDto } from './dto/screening.dto';
import { StockScreeningService } from './stock-screening.service';

@ApiTags('Stock Screening')
@Controller('stock-screening')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class StockScreeningController {
  constructor(private readonly service: StockScreeningService) {}
  @Post('runs')
  @ApiOperation({ summary: '创建策略筛选快照任务' })
  @ApiResponse({ status: 201, description: '任务已排队，使用返回 id 轮询' })
  create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateScreeningRunDto) {
    return this.service.create(user.id, dto);
  }

  @Get('runs')
  @ApiOperation({ summary: '列出当前用户的筛选任务' })
  @ApiResponse({ status: 200, description: '获取成功' })
  list(@CurrentUser() user: Omit<User, 'password'>, @Query() query: ScreeningRunsQueryDto) {
    return this.service.list(user.id, query.page, query.limit);
  }

  @Get('runs/:id')
  @ApiOperation({ summary: '获取当前用户的筛选任务和结果' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '任务不存在' })
  get(@CurrentUser() user: Omit<User, 'password'>, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.id, id);
  }
}
