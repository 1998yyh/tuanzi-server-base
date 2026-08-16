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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AssetsService } from './assets.service';
import { CreateAssetDto, QueryAssetsDto } from './dto/asset.dto';

@ApiTags('素材库')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get()
  @ApiOperation({ summary: '素材列表（类型/关键词过滤 + 分页）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@CurrentUser() user: Omit<User, 'password'>, @Query() query: QueryAssetsDto) {
    return this.assetsService.findAll(user, query);
  }

  @Post()
  @ApiOperation({ summary: '新建素材', description: '文本素材传 textContent；图片/视频传 mediaId' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateAssetDto) {
    return this.assetsService.create(user, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除素材' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '素材不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.assetsService.remove(user, id);
  }
}
