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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CanvasService } from './canvas.service';
import { CanvasOpsService } from './canvas-ops.service';
import { CreateCanvasProjectDto } from './dto/create-canvas-project.dto';
import { QueryCanvasProjectsDto } from './dto/query-canvas-projects.dto';
import {
  ApplyOpsDto,
  RenameCanvasProjectDto,
  UpdateCanvasDocumentDto,
} from './dto/canvas-document.dto';

@ApiTags('画布')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('canvas-projects')
export class CanvasController {
  constructor(
    private readonly canvasService: CanvasService,
    private readonly canvasOpsService: CanvasOpsService,
  ) {}

  @Get()
  @ApiOperation({ summary: '画布列表（分页，摘要不含完整文档）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(
    @CurrentUser() user: Omit<User, 'password'>,
    @Query() query: QueryCanvasProjectsDto,
  ) {
    return this.canvasService.findAll(user, query);
  }

  @Post()
  @ApiOperation({ summary: '创建画布' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateCanvasProjectDto) {
    return this.canvasService.create(user, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '画布详情（含完整文档与版本号）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '画布不存在' })
  async findOne(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.canvasService.findOne(user, id);
  }

  @Get(':id/version')
  @ApiOperation({ summary: '画布版本号', description: '前端静默比对用，避免整文档传输' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findVersion(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.canvasService.findVersion(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '重命名画布' })
  @ApiResponse({ status: 200, description: '更新成功' })
  async rename(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameCanvasProjectDto,
  ) {
    return this.canvasService.rename(user, id, dto.name);
  }

  @Put(':id')
  @ApiOperation({
    summary: '保存画布文档（整文档 + 乐观锁）',
    description: 'baseVersion 与库中不一致返回 409，前端应重新拉取',
  })
  @ApiResponse({ status: 200, description: '保存成功' })
  @ApiResponse({ status: 409, description: '版本冲突' })
  async updateDocument(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCanvasDocumentDto,
  ) {
    return this.canvasService.updateDocument(user, id, dto);
  }

  @Post(':id/ops')
  @ApiOperation({
    summary: '批量应用画布 ops',
    description: 'Agent 工具与前端共用；run_generation op 只收集不执行（生成接线后消费）',
  })
  @ApiResponse({ status: 200, description: '应用成功' })
  @ApiResponse({ status: 400, description: 'ops 参数不合法' })
  @ApiResponse({ status: 409, description: '版本冲突' })
  async applyOps(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyOpsDto,
  ) {
    await this.canvasService.findOwned(id, user.id);
    const ops = this.canvasOpsService.validateOps(dto.ops);
    return this.canvasOpsService.applyOps(id, ops, dto.baseVersion);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除画布' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '画布不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.canvasService.remove(user, id);
  }
}
