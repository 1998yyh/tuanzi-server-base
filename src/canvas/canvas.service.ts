import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/users.entity';
import { CanvasProject, CanvasProjectSummary, CanvasProjectView } from './canvas-project.entity';
import { CanvasDocument, EMPTY_CANVAS_DOCUMENT } from './canvas.types';
import { CreateCanvasProjectDto } from './dto/create-canvas-project.dto';
import { UpdateCanvasDocumentDto } from './dto/canvas-document.dto';
import { QueryCanvasProjectsDto } from './dto/query-canvas-projects.dto';

type CurrentUser = Omit<User, 'password'>;

@Injectable()
export class CanvasService {
  constructor(
    @InjectRepository(CanvasProject)
    private readonly projectRepo: Repository<CanvasProject>,
  ) {}

  async create(user: CurrentUser, dto: CreateCanvasProjectDto): Promise<CanvasProjectView> {
    const project = await this.projectRepo.save(
      this.projectRepo.create({
        userId: user.id,
        name: dto.name,
        document: EMPTY_CANVAS_DOCUMENT,
        version: 1,
      }),
    );
    return this.toView(project);
  }

  async findAll(
    user: CurrentUser,
    query: QueryCanvasProjectsDto,
  ): Promise<{
    items: CanvasProjectSummary[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const qb = this.projectRepo
      .createQueryBuilder('p')
      // 列表不加载 document 大字段，摘要计数用 JSON_LENGTH 在 SQL 侧算好
      .select(['p.id', 'p.name', 'p.version', 'p.createdAt', 'p.updatedAt'])
      .addSelect("JSON_LENGTH(p.document, '$.nodes')", 'nodeCount')
      .addSelect("JSON_LENGTH(p.document, '$.connections')", 'connectionCount')
      .where('p.user_id = :userId', { userId: user.id })
      .orderBy('p.updatedAt', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);
    if (query.keyword) {
      qb.andWhere('p.name LIKE :keyword', { keyword: `%${query.keyword}%` });
    }
    const { entities, raw } = await qb.getRawAndEntities();
    const total = await qb.getCount();
    return {
      items: entities.map((p, index) => this.toSummary(p, raw[index])),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async findOne(user: CurrentUser, id: string): Promise<CanvasProjectView> {
    const project = await this.findOwned(id, user.id);
    return this.toView(project);
  }

  /** 仅取版本号（前端静默比对用，避免整文档传输） */
  async findVersion(user: CurrentUser, id: string): Promise<{ version: number }> {
    const project = await this.projectRepo.findOne({
      where: { id, userId: user.id },
      select: ['version'],
    });
    if (!project) {
      throw new NotFoundException(`画布 #${id} 不存在`);
    }
    return { version: project.version };
  }

  /** 重命名：只更新 name 列（userId 条件天然防越权），不读回 document，避免并发下旧文档覆盖他人写入并回滚 version */
  async rename(user: CurrentUser, id: string, name: string): Promise<CanvasProjectView> {
    const project = await this.findOwned(id, user.id);
    const updateResult = await this.projectRepo.update(
      { id: project.id, userId: user.id },
      { name },
    );
    if (!updateResult.affected) {
      throw new NotFoundException(`画布 #${id} 不存在`);
    }
    return this.toView({ ...project, name });
  }

  /**
   * 整文档保存（前端 debounced PUT）。乐观锁：
   * baseVersion 与库中不一致 → 409，前端应重新拉取。
   */
  async updateDocument(
    user: CurrentUser,
    id: string,
    dto: UpdateCanvasDocumentDto,
  ): Promise<CanvasProjectView> {
    const project = await this.findOwned(id, user.id);
    if (project.version !== dto.baseVersion) {
      throw new ConflictException('画布已被其他操作修改，请刷新后重试');
    }
    const updateResult = await this.projectRepo.update(
      { id, version: dto.baseVersion },
      { document: dto.document as CanvasDocument, version: project.version + 1 },
    );
    if (!updateResult.affected) {
      throw new ConflictException('画布已被其他操作修改，请刷新后重试');
    }
    return this.toView({
      ...project,
      document: dto.document as CanvasDocument,
      version: project.version + 1,
    });
  }

  async remove(user: CurrentUser, id: string): Promise<void> {
    const project = await this.findOwned(id, user.id);
    await this.projectRepo.remove(project);
  }

  /** 内部用：按 id + userId 取实体（Agent 工具/ops 服务的归属校验入口） */
  async findOwned(id: string, userId: string): Promise<CanvasProject> {
    const project = await this.projectRepo.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException(`画布 #${id} 不存在`);
    }
    if (project.userId !== userId) {
      throw new NotFoundException(`画布 #${id} 不存在`);
    }
    return project;
  }

  toView(project: CanvasProject): CanvasProjectView {
    const { user: _user, ...view } = project;
    return view;
  }

  private toSummary(
    project: CanvasProject,
    counts?: { nodeCount?: number | null; connectionCount?: number | null },
  ): CanvasProjectSummary {
    const { user: _user, document, ...rest } = project;
    void _user;
    const doc = document as CanvasDocument | undefined;
    // findAll 走 SQL 侧 JSON_LENGTH 计数（raw 行）；无 counts 时回退文档数组长度
    const nodeCount = counts?.nodeCount ?? doc?.nodes?.length ?? 0;
    const connectionCount = counts?.connectionCount ?? doc?.connections?.length ?? 0;
    return {
      ...rest,
      nodeCount: Number(nodeCount) || 0,
      connectionCount: Number(connectionCount) || 0,
    };
  }
}
