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
  ParseEnumPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { DailyReportsService } from './daily-reports.service';
import {
  CreateDailyReportDto,
  QueryDailyReportDto,
  UpdateDailyReportDto,
} from './dto/daily-report.dto';
import { DailyReportType } from './daily-reports.entity';
import { DailyReport } from './daily-reports.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('日报')
@Controller('daily-reports')
export class DailyReportsController {
  constructor(private readonly dailyReportsService: DailyReportsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建日报', description: '创建新的日报（支持AI情报员/汪汪队自动调用）' })
  @ApiResponse({ status: 201, description: '创建成功', type: DailyReport })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 409, description: '该类型该日期的日报已存在' })
  async create(@Body() createDto: CreateDailyReportDto): Promise<DailyReport> {
    return this.dailyReportsService.create(createDto);
  }

  @Get()
  @ApiOperation({ summary: '获取日报列表', description: '支持按类型、日期筛选，支持分页' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@Query() query: QueryDailyReportDto) {
    return this.dailyReportsService.findAll(query);
  }

  @Get('dates/:type')
  @ApiOperation({ summary: '获取指定类型的日期列表', description: '返回该类型所有日报日期' })
  @ApiResponse({ status: 200, description: '获取成功', type: [String] })
  async getDates(
    @Param('type', new ParseEnumPipe(DailyReportType)) type: DailyReportType,
  ): Promise<string[]> {
    return this.dailyReportsService.getDatesByType(type);
  }

  @Get('latest/:type')
  @ApiOperation({ summary: '获取指定类型的最新日报' })
  @ApiResponse({ status: 200, description: '获取成功', type: DailyReport })
  @ApiResponse({ status: 404, description: '未找到' })
  async getLatest(
    @Param('type', new ParseEnumPipe(DailyReportType)) type: DailyReportType,
  ): Promise<DailyReport | null> {
    return this.dailyReportsService.getLatestByType(type);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取日报详情' })
  @ApiResponse({ status: 200, description: '获取成功', type: DailyReport })
  @ApiResponse({ status: 404, description: '日报不存在' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<DailyReport> {
    return this.dailyReportsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新日报' })
  @ApiResponse({ status: 200, description: '更新成功', type: DailyReport })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '日报不存在' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateDailyReportDto,
  ): Promise<DailyReport> {
    return this.dailyReportsService.update(id, updateDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除日报' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 404, description: '日报不存在' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.dailyReportsService.remove(id);
  }
}
