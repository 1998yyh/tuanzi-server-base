import { PartialType } from '@nestjs/swagger';
import { CreateMcpServerDto } from './create-mcp-server.dto';

/** 所有字段可选；env/headers 不传则保持原值，传 null 语义不支持（清空传 {}） */
export class UpdateMcpServerDto extends PartialType(CreateMcpServerDto) {}
