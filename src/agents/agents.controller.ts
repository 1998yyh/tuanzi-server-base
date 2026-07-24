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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { QueryAgentsDto } from './dto/query-agents.dto';
import { AgentResponseDto } from './dto/agent-response.dto';

@ApiTags('Agent')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post()
  @ApiOperation({ summary: '创建 Agent', description: 'stdio 类型的 MCP Server 仅管理员可配置' })
  @ApiResponse({ status: 201, description: '创建成功', type: AgentResponseDto })
  @ApiResponse({ status: 401, description: '未授权' })
  @ApiResponse({ status: 403, description: '非管理员配置 stdio 类型 MCP Server' })
  async create(
    @CurrentUser() user: Omit<User, 'password'>,
    @Body() dto: CreateAgentDto,
  ): Promise<AgentResponseDto> {
    return this.agentsService.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Agent 分页列表', description: '只返回当前用户的启用中 Agent' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@CurrentUser() user: Omit<User, 'password'>, @Query() query: QueryAgentsDto) {
    return this.agentsService.findAll(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Agent 详情', description: 'API Key 只返回脱敏后 4 位' })
  @ApiResponse({ status: 200, description: '获取成功', type: AgentResponseDto })
  @ApiResponse({ status: 404, description: 'Agent 不存在' })
  async findOne(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentResponseDto> {
    return this.agentsService.findOne(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新 Agent 配置', description: 'apiKey 不传则保持原值' })
  @ApiResponse({ status: 200, description: '更新成功', type: AgentResponseDto })
  @ApiResponse({ status: 403, description: '非管理员配置 stdio 类型 MCP Server' })
  @ApiResponse({ status: 404, description: 'Agent 不存在' })
  async update(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgentDto,
  ): Promise<AgentResponseDto> {
    return this.agentsService.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '删除 Agent（软删除）',
    description: '置 is_active=false，该 Agent 下的会话将不可继续发消息',
  })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: 'Agent 不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.agentsService.remove(user.id, id);
  }
}
