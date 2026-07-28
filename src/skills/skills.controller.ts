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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SkillsService } from './skills.service';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';

@ApiTags('Skill')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('skills')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Get()
  @ApiOperation({
    summary: '全局 Skill 列表',
    description: '只返回启用中的 Skill，用于 Agent 配置界面选配',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll() {
    return this.skillsService.findAllActive();
  }

  @Post()
  @ApiOperation({ summary: '创建 Skill', description: 'name 全局唯一，snake_case' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 400, description: '参数非法（含未注册的内置工具名）' })
  @ApiResponse({ status: 409, description: '名称已存在' })
  async create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateSkillDto) {
    return this.skillsService.create(user, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新 Skill', description: '仅创建者或管理员' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 403, description: '非创建者且非管理员' })
  @ApiResponse({ status: 404, description: 'Skill 不存在' })
  async update(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSkillDto,
  ) {
    return this.skillsService.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除 Skill', description: '仅创建者或管理员；关联关系自动级联清理' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: 'Skill 不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.skillsService.remove(user, id);
  }
}
