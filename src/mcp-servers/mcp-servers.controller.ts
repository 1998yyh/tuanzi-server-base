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
import { McpServersService } from './mcp-servers.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { QueryMcpServerDto } from './dto/query-mcp-server.dto';

@ApiTags('MCP Server')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('mcp-servers')
export class McpServersController {
  constructor(private readonly mcpServersService: McpServersService) {}

  @Get()
  @ApiOperation({
    summary: '全局 MCP Server 列表',
    description: '只返回启用中的 server，env/headers 不回显',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@Query() query: QueryMcpServerDto) {
    return this.mcpServersService.findAllActive(query);
  }

  @Post()
  @ApiOperation({ summary: '创建 MCP Server', description: 'stdio 类型仅管理员可创建' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 403, description: '非管理员创建 stdio 类型' })
  @ApiResponse({ status: 409, description: '名称已存在' })
  async create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateMcpServerDto) {
    return this.mcpServersService.create(user, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '更新 MCP Server',
    description: '仅创建者或管理员；env/headers 不传则保持原值',
  })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 403, description: '非创建者且非管理员' })
  @ApiResponse({ status: 404, description: 'MCP Server 不存在' })
  async update(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMcpServerDto,
  ) {
    return this.mcpServersService.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '删除 MCP Server',
    description: '仅创建者或管理员；关联关系自动级联清理',
  })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: 'MCP Server 不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.mcpServersService.remove(user, id);
  }
}
