import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class UpdateAgentMcpServersDto {
  @ApiProperty({
    type: [String],
    example: ['b3b7c6e2-....'],
    description: '关联的 MCP Server ID 列表（整体替换，传空数组清空）',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  mcpServerIds: string[];
}
