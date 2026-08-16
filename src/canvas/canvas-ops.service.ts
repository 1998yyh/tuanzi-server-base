import { BadRequestException, Injectable } from '@nestjs/common';
import { CanvasDocumentService } from './canvas-document.service';
import { CanvasDocument } from './canvas.types';
import {
  applyCanvasOps,
  CanvasAgentOp,
  GenerationRequest,
  summarizeCanvasOps,
} from './lib/canvas-ops';
import { canvasOpsArraySchema } from './lib/canvas-op-schemas';

export interface ApplyOpsResponse {
  document: CanvasDocument;
  version: number;
  summary: string;
  generationRequests: GenerationRequest[];
  touchedNodeIds: string[];
}

/**
 * 画布 ops 服务：Agent 工具与前端共用的批量操作写路径。
 * zod 校验 → applyMutation 乐观锁 → applyCanvasOps 纯函数应用。
 * run_generation op 只收集不执行，由上层（GenerationService 接线后）消费。
 */
@Injectable()
export class CanvasOpsService {
  constructor(private readonly documentService: CanvasDocumentService) {}

  /** 校验 ops 形状（Agent 工具与 HTTP 入口共用） */
  validateOps(ops: unknown): CanvasAgentOp[] {
    const parsed = canvasOpsArraySchema.safeParse(ops);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestException(`ops 参数不合法：${issue.path.join('.')} ${issue.message}`);
    }
    return parsed.data as CanvasAgentOp[];
  }

  async applyOps(
    projectId: string,
    ops: CanvasAgentOp[],
    baseVersion?: number,
  ): Promise<ApplyOpsResponse> {
    const mutation = await this.documentService.applyMutation(
      projectId,
      baseVersion ?? null,
      (document) => {
        const applied = applyCanvasOps(document, ops);
        return {
          document: applied.document,
          result: applied,
        };
      },
    );
    return {
      document: mutation.document,
      version: mutation.version,
      summary: summarizeCanvasOps(ops),
      generationRequests: mutation.result.generationRequests,
      touchedNodeIds: mutation.result.touchedNodeIds,
    };
  }

  /** 单节点 patch（生成回填等场景：基于最新版本，不校验 version） */
  async patchNodeMetadata(
    projectId: string,
    nodeId: string,
    metadata: Record<string, unknown>,
  ): Promise<{ version: number }> {
    const mutation = await this.documentService.applyMutation(projectId, null, (document) => ({
      document: {
        ...document,
        nodes: (document.nodes ?? []).map((node) =>
          node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...metadata } } : node,
        ),
      },
      result: undefined,
    }));
    return { version: mutation.version };
  }
}
