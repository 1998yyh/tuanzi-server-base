import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { DailyReportsService } from './daily-reports.service';
import { CreateDailyReportDto, QueryDailyReportDto } from './dto/daily-report.dto';
import { DailyReport } from './daily-reports.entity';

@ApiTags('日报')
@ApiBearerAuth()
@Controller('daily-reports')
export class DailyReportsController {
  constructor(private readonly dailyReportsService: DailyReportsService) {}

  @Post()
  @ApiOperation({ summary: '创建日报', description: '创建新的日报（支持AI情报员/汪汪队自动调用）' })
  @ApiResponse({ status: 201, description: '创建成功', type: DailyReport })
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
  async getDates(@Param('type') type: string): Promise<string[]> {
    return this.dailyReportsService.getDatesByType(type as any);
  }

  @Get('latest/:type')
  @ApiOperation({ summary: '获取指定类型的最新日报' })
  @ApiResponse({ status: 200, description: '获取成功', type: DailyReport })
  @ApiResponse({ status: 404, description: '未找到' })
  async getLatest(@Param('type') type: string): Promise<DailyReport | null> {
    return this.dailyReportsService.getLatestByType(type as any);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取日报详情' })
  @ApiResponse({ status: 200, description: '获取成功', type: DailyReport })
  @ApiResponse({ status: 404, description: '日报不存在' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<DailyReport> {
    return this.dailyReportsService.findOne(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除日报' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '日报不存在' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.dailyReportsService.remove(id);
  }
}