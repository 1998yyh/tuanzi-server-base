import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanvasProject } from './canvas-project.entity';
import { CanvasDocument } from './canvas.types';

export interface MutationResult<T> {
  document: CanvasDocument;
  version: number;
  result: T;
}

/**
 * 画布文档变更的唯一入口（乐观锁核心）。
 * 所有写路径（前端整文档保存 / Agent ops / 生成任务回填）都必须经过这里：
 * 读 document → 内存执行 mutator → UPDATE ... WHERE id=? AND version=? 原子落库。
 */
@Injectable()
export class CanvasDocumentService {
  constructor(
    @InjectRepository(CanvasProject)
    private readonly projectRepo: Repository<CanvasProject>,
  ) {}

  /**
   * @param expectedVersion null 表示不校验版本（生成回填等「基于最新版 patch」场景）
   * @param mutator 基于当前文档计算新文档与附带结果，必须是纯函数
   */
  async applyMutation<T>(
    projectId: string,
    expectedVersion: number | null,
    mutator: (document: CanvasDocument) => { document: CanvasDocument; result: T },
  ): Promise<MutationResult<T>> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`画布 #${projectId} 不存在`);
    }
    if (expectedVersion !== null && project.version !== expectedVersion) {
      throw new ConflictException('画布已被其他操作修改，请刷新后重试');
    }

    const previousDocument = project.document ?? { nodes: [], connections: [] };
    const { document, result } = mutator(previousDocument);

    // 无变更短路：mutator 结果与当前文档 JSON 一致时跳过 UPDATE（version 不变），
    // 避免「空 patch」类写入（如回填已存在的内容）无谓递增版本号、引发前端 409
    if (JSON.stringify(document) === JSON.stringify(previousDocument)) {
      return { document: previousDocument, version: project.version, result };
    }

    const updateResult = await this.projectRepo.update(
      { id: projectId, version: project.version },
      { document, version: project.version + 1 },
    );
    if (!updateResult.affected) {
      // 读到写到之间被并发修改（version 已变化）
      throw new ConflictException('画布已被其他操作修改，请刷新后重试');
    }
    return { document, version: project.version + 1, result };
  }
}
