import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { WeeklyGoalsService } from './weekly-goals.service';
import { CreateWeeklyGoalDto, QueryWeeklyGoalDto } from './dto/weekly-goal.dto';
import { WeeklyGoal } from './weekly-goals.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/users.entity';

@ApiTags('周目标')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('weekly-goals')
export class WeeklyGoalsController {
  constructor(private readonly weeklyGoalsService: WeeklyGoalsService) {}

  @Post()
  @ApiOperation({
    summary: '创建周目标',
    description: '截止日期由后端自动生成（创建时间 + 7 天），不可修改',
  })
  @ApiResponse({ status: 201, description: '创建成功', type: WeeklyGoal })
  @ApiResponse({ status: 401, description: '未授权' })
  async create(
    @CurrentUser() user: Omit<User, 'password'>,
    @Body() createDto: CreateWeeklyGoalDto,
  ): Promise<WeeklyGoal> {
    return this.weeklyGoalsService.create(user.id, createDto);
  }

  @Get()
  @ApiOperation({
    summary: '获取周目标列表',
    description: '进行中按截止日升序，已完成按完成时间倒序',
  })
  @ApiResponse({ status: 200, description: '获取成功', type: [WeeklyGoal] })
  @ApiResponse({ status: 401, description: '未授权' })
  async findAll(
    @CurrentUser() user: Omit<User, 'password'>,
    @Query() query: QueryWeeklyGoalDto,
  ): Promise<WeeklyGoal[]> {
    return this.weeklyGoalsService.findAll(user.id, query);
  }

  @Patch(':id/complete')
  @ApiOperation({ summary: '完成周目标', description: '标记完成并归档到完成记录' })
  @ApiResponse({ status: 200, description: '完成成功', type: WeeklyGoal })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '周目标不存在' })
  @ApiResponse({ status: 409, description: '周目标已完成' })
  async complete(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WeeklyGoal> {
    return this.weeklyGoalsService.complete(user.id, id);
  }

  @Patch(':id/uncomplete')
  @ApiOperation({ summary: '撤销完成', description: '将已归档的周目标退回进行中' })
  @ApiResponse({ status: 200, description: '撤销成功', type: WeeklyGoal })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '周目标不存在' })
  @ApiResponse({ status: 409, description: '周目标尚未完成' })
  async uncomplete(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WeeklyGoal> {
    return this.weeklyGoalsService.uncomplete(user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除周目标', description: '软删除，进行中与已归档的均可删除' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '周目标不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.weeklyGoalsService.remove(user.id, id);
  }
}
