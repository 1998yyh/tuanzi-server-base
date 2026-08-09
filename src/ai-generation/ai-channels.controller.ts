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
import { AiChannelsService } from './ai-channels.service';
import { CreateAiChannelDto } from './dto/create-ai-channel.dto';
import { UpdateAiChannelDto } from './dto/update-ai-channel.dto';

@ApiTags('AI 渠道')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai-channels')
export class AiChannelsController {
  constructor(private readonly aiChannelsService: AiChannelsService) {}

  @Get()
  @ApiOperation({ summary: '我的 AI 渠道列表', description: 'apiKey 只回脱敏值' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@CurrentUser() user: Omit<User, 'password'>) {
    return this.aiChannelsService.findAll(user);
  }

  @Post()
  @ApiOperation({ summary: '创建 AI 渠道' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateAiChannelDto) {
    return this.aiChannelsService.create(user, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新 AI 渠道', description: 'apiKey 不传则保持原值' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '渠道不存在' })
  async update(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAiChannelDto,
  ) {
    return this.aiChannelsService.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除 AI 渠道' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '渠道不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.aiChannelsService.remove(user, id);
  }
}
