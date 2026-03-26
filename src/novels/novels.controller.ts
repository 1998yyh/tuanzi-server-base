import {
  Controller,
  Get,
  Param,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { NovelsService } from './novels.service';
import { QueryNovelDto, QueryChapterDto } from './dto';
import { Novel } from './novel.entity';
import { Chapter } from './chapter.entity';

@ApiTags('小说')
@Controller('novels')
export class NovelsController {
  constructor(private readonly novelsService: NovelsService) {}

  @Get()
  @ApiOperation({ summary: '获取小说列表', description: '分页获取小说列表，支持按状态筛选' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@Query() query: QueryNovelDto) {
    return this.novelsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取小说详情' })
  @ApiResponse({ status: 200, description: '获取成功', type: Novel })
  @ApiResponse({ status: 404, description: '小说不存在' })
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<Novel> {
    return this.novelsService.findOne(id);
  }

  @Get(':id/chapters')
  @ApiOperation({ summary: '获取章节列表', description: '获取指定小说的章节列表（不含正文）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '小说不存在' })
  async findChapters(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: QueryChapterDto,
  ) {
    return this.novelsService.findChapters(id, query);
  }

  @Get(':id/chapters/:chapterId')
  @ApiOperation({ summary: '获取章节内容', description: '获取指定章节的完整内容' })
  @ApiResponse({ status: 200, description: '获取成功', type: Chapter })
  @ApiResponse({ status: 404, description: '小说或章节不存在' })
  async findChapter(
    @Param('id', ParseIntPipe) id: number,
    @Param('chapterId', ParseIntPipe) chapterId: number,
  ): Promise<Chapter> {
    return this.novelsService.findChapter(id, chapterId);
  }
}