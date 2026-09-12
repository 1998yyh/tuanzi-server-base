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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/users.entity';
import { StockStrategiesService } from './stock-strategies.service';
import {
  CreateStrategyDto,
  DeleteStrategyDto,
  StrategyPageDto,
  UpdateStrategyDto,
} from './dto/strategy.dto';
import { listTemplates } from './strategy-definition';
@ApiTags('股票策略库')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stock-strategies')
export class StockStrategiesController {
  constructor(private readonly service: StockStrategiesService) {}
  @Get('templates')
  @ApiOperation({ summary: '内置固定指标策略模板（只读，复制定义后创建个人策略）' })
  @ApiResponse({ status: 200, description: '返回五个指标模板' })
  templates() {
    return { items: listTemplates() };
  }

  @Get()
  @ApiOperation({ summary: '分页查看我的策略' })
  @ApiResponse({ status: 200, description: '仅返回当前用户未删除策略' })
  list(@CurrentUser() user: Omit<User, 'password'>, @Query() query: StrategyPageDto) {
    return this.service.list(user.id, query.page, query.limit);
  }
  @Post()
  @ApiOperation({ summary: '保存自定义组合策略' })
  @ApiResponse({ status: 201, description: '创建成功，版本为1' })
  @ApiResponse({ status: 400, description: '策略参数无效' })
  @ApiResponse({ status: 409, description: '策略名称已使用' })
  create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateStrategyDto) {
    return this.service.create(user.id, dto);
  }
  @Get(':id')
  @ApiOperation({ summary: '查看策略详情与版本快照' })
  @ApiResponse({ status: 200, description: '策略定义与历史版本' })
  @ApiResponse({ status: 404, description: '策略不存在' })
  get(@CurrentUser() user: Omit<User, 'password'>, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.id, id);
  }
  @Put(':id')
  @ApiOperation({ summary: '完整替换个人策略，保留旧版本；需传当前版本号' })
  @ApiResponse({ status: 200, description: '更新成功，版本递增' })
  @ApiResponse({ status: 400, description: '策略参数无效' })
  @ApiResponse({ status: 404, description: '策略不存在' })
  @ApiResponse({ status: 409, description: '名称或版本冲突' })
  update(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStrategyDto,
  ) {
    return this.service.update(user.id, id, dto);
  }
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '逻辑删除个人策略（保留历史和名称）；查询参数需传当前version' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '策略不存在' })
  @ApiResponse({ status: 409, description: '版本冲突' })
  remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: DeleteStrategyDto,
  ) {
    return this.service.remove(user.id, id, dto.version);
  }
}
