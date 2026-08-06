import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { McpServerType } from '../mcp-server.entity';

export class QueryMcpServerDto {
  @ApiProperty({ enum: McpServerType, required: false, description: '按连接类型筛选' })
  @IsEnum(McpServerType)
  @IsOptional()
  type?: McpServerType;
}
