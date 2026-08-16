import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class CanvasNodeDto {
  @ApiProperty({ description: '节点 ID' })
  @IsString()
  id: string;

  @ApiProperty({ description: '节点类型：image/text/config/video/audio/group' })
  @IsString()
  type: string;

  @ApiProperty({ description: '节点标题' })
  @IsString()
  title: string;

  @ApiProperty({ description: '世界坐标' })
  @IsObject()
  position: { x: number; y: number };

  @ApiProperty({ description: '宽度' })
  @IsInt()
  @Min(1)
  width: number;

  @ApiProperty({ description: '高度' })
  @IsInt()
  @Min(1)
  height: number;

  @ApiProperty({ required: false, description: '节点元数据（开放字段）' })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

class CanvasConnectionDto {
  @ApiProperty({ description: '连线 ID' })
  @IsString()
  id: string;

  @ApiProperty({ description: '起点节点 ID' })
  @IsString()
  fromNodeId: string;

  @ApiProperty({ description: '终点节点 ID' })
  @IsString()
  toNodeId: string;
}

export class CanvasDocumentDto {
  @ApiProperty({ type: [CanvasNodeDto], description: '节点列表' })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CanvasNodeDto)
  nodes: CanvasNodeDto[];

  @ApiProperty({ type: [CanvasConnectionDto], description: '连线列表' })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CanvasConnectionDto)
  connections: CanvasConnectionDto[];

  @ApiProperty({ required: false, description: '视口 {x, y, k}' })
  @IsObject()
  @IsOptional()
  viewport?: { x: number; y: number; k: number };
}

export class UpdateCanvasDocumentDto {
  @ApiProperty({ type: CanvasDocumentDto, description: '完整画布文档' })
  @ValidateNested()
  @Type(() => CanvasDocumentDto)
  document: CanvasDocumentDto;

  @ApiProperty({ example: 3, description: '基于的版本号（乐观锁），与库中不一致返回 409' })
  @IsInt()
  @Min(1)
  baseVersion: number;
}

export class RenameCanvasProjectDto {
  @ApiProperty({ example: '新名字', description: '画布名称' })
  @IsString()
  @Length(1, 200)
  name: string;
}

export class ApplyOpsDto {
  @ApiProperty({
    description:
      'ops 数组（add_node/update_node/delete_node/delete_connections/connect_nodes/set_viewport/select_nodes/run_generation）',
    type: 'array',
    items: { type: 'object' },
  })
  @IsArray()
  @ArrayMaxSize(500)
  ops: Record<string, unknown>[];

  @ApiProperty({ required: false, example: 3, description: '基于的版本号（可选，不传则不校验）' })
  @IsInt()
  @Min(1)
  @IsOptional()
  baseVersion?: number;
}
