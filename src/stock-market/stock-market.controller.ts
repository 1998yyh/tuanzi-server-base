import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { BarsQueryDto, QuotesQueryDto, SearchStocksQueryDto } from './dto/market.dto';
import { StockMarketService } from './stock-market.service';

@ApiTags('Stock Market')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stock-market')
export class StockMarketController {
  constructor(private readonly market: StockMarketService) {}

  @Get('quotes')
  @ApiOperation({ summary: '批量查询 A 股最新行情' })
  @ApiResponse({ status: 200, description: '返回真实行情源报价及抓取时间' })
  getQuotes(@Query() query: QuotesQueryDto) {
    return this.market.getQuotes(query.codes);
  }

  @Get('bars')
  @ApiOperation({ summary: '查询已完成 K 线及标准技术指标' })
  @ApiResponse({ status: 200, description: '指标与 K 线按下标对齐，预热期值为 null' })
  getBars(@Query() query: BarsQueryDto) {
    return this.market.getBars(query.code, query.period, query.adjustment);
  }

  @Get('search')
  @ApiOperation({ summary: '按代码或名称搜索 A 股目录' })
  @ApiResponse({ status: 200, description: '最多返回 50 条，并标注目录覆盖范围' })
  search(@Query() query: SearchStocksQueryDto) {
    return this.market.search(query.q);
  }

  @Get('indices')
  @ApiOperation({ summary: '获取上证、深证与创业板指数' })
  indices() {
    return this.market.getIndices();
  }

  @Get('indices/:code/bars')
  @ApiOperation({ summary: '获取大盘指数完整日线或周线' })
  indexBars(
    @Param('code') code: 'sh000001' | 'sz399001' | 'sz399006',
    @Query('period') period: 'day' | 'week',
  ) {
    return this.market.getIndexBars(code, period);
  }
}
