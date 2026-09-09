// Adapted from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, SelectQueryBuilder } from 'typeorm';
import { createHash } from 'node:crypto';
import { User, UserRole } from '../users/users.entity';
import { PromptSource, PromptSourceView } from './prompt-source.entity';
import { PromptItem } from './prompt-item.entity';
import { DEFAULT_PROMPT_SOURCES } from './lib/prompt-presets';
import { RawPrompt, runPromptSource } from './lib/prompt-normalize';
import { classifyPrompt } from './lib/prompt-category';
import { CreatePromptSourceDto, UpdatePromptSourceDto } from './dto/prompt-source.dto';
import { CreatePromptDto, UpdatePromptDto } from './dto/prompt-item.dto';
import { QueryPromptsDto } from './dto/query-prompts.dto';

type CurrentUser = Omit<User, 'password'>;
export type Prompt = RawPrompt & {
  sourceId: string;
  category: string;
  githubUrl: string;
  sourceName: string;
  canEdit: boolean;
};
export const ALL_PROMPTS_OPTION = 'all';
export type PromptListResponse = {
  items: Prompt[];
  tags: string[];
  categories: string[];
  total: number;
  canManage: boolean;
};
export type PromptSourceStatus = {
  sourceId: string;
  count: number;
  lastSuccessAt: string;
  lastError: string;
};
export type PromptSourceRefreshResult = PromptSourceStatus & {
  sourceName: string;
  success: boolean;
  imported: number;
  skipped: number;
};
export type PromptSourceRefreshSummary = {
  results: PromptSourceRefreshResult[];
  total: number;
  successCount: number;
  failureCount: number;
};
const MAX_USER_SOURCES = 50;

/** 正文只读写 MySQL；外部抓取仅由显式导入触发，绝不在查询或启动时刷新内容。 */
@Injectable()
export class PromptsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PromptsService.name);
  private readonly imports = new Map<string, Promise<PromptSourceRefreshResult>>();
  private readonly importStatuses = new Map<string, PromptSourceRefreshResult>();
  constructor(
    @InjectRepository(PromptSource) private readonly sourceRepo: Repository<PromptSource>,
    @InjectRepository(PromptItem) private readonly itemRepo: Repository<PromptItem>,
  ) {}

  /** 内置源幂等种子：按 url 去重，只插缺失的 */
  async onApplicationBootstrap(): Promise<void> {
    const existing = await this.sourceRepo.find({ where: { userId: IsNull() } });
    const existingUrls = new Set(existing.map((s) => s.url));
    const missing = DEFAULT_PROMPT_SOURCES.filter((s) => !existingUrls.has(s.url));
    if (!missing.length) return;
    await this.sourceRepo.save(
      missing.map((s, index) =>
        this.sourceRepo.create({
          userId: null,
          name: s.name,
          url: s.url,
          homepage: s.homepage,
          isBuiltin: true,
          isActive: true,
          sortOrder: index,
        }),
      ),
    );
    this.logger.log(`已种子化 ${missing.length} 个内置提示词源`);
  }

  // ---------------------------------------------------------------------------
  // 源管理
  // ---------------------------------------------------------------------------

  /** 当前用户可见的源：内置（共享）+ 自建 */
  async listSources(user: CurrentUser): Promise<PromptSourceView[]> {
    const sources = await this.sourceRepo.find({
      where: [{ userId: IsNull() }, { userId: user.id }],
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return sources.map((s) => this.toView(s));
  }

  async createSource(user: CurrentUser, dto: CreatePromptSourceDto): Promise<PromptSourceView> {
    const count = await this.sourceRepo.count({ where: { userId: user.id } });
    if (count >= MAX_USER_SOURCES) {
      throw new BadRequestException(`自建提示词源最多 ${MAX_USER_SOURCES} 个`);
    }
    const source = await this.sourceRepo.save(
      this.sourceRepo.create({
        userId: user.id,
        name: dto.name,
        url: dto.url,
        homepage: dto.homepage ?? '',
        isBuiltin: false,
        isActive: true,
        sortOrder: 0,
      }),
    );
    return this.toView(source);
  }

  async updateSource(
    user: CurrentUser,
    id: string,
    dto: UpdatePromptSourceDto,
  ): Promise<PromptSourceView> {
    const source = await this.findEditableSource(user, id);
    if (source.userId === null) await this.assertManager(user);
    if (source.isBuiltin) {
      // 内置源只允许切换启用状态（名称/地址/排序保持预置）
      if (
        dto.name !== undefined ||
        dto.url !== undefined ||
        dto.homepage !== undefined ||
        dto.sortOrder !== undefined
      ) {
        throw new BadRequestException('内置提示词源只能切换启用状态');
      }
    }
    Object.assign(source, {
      name: dto.name ?? source.name,
      url: dto.url ?? source.url,
      homepage: dto.homepage ?? source.homepage,
      isActive: dto.isActive ?? source.isActive,
      sortOrder: dto.sortOrder ?? source.sortOrder,
    });
    const saved = await this.sourceRepo.save(source);

    return this.toView(saved);
  }

  async removeSource(user: CurrentUser, id: string): Promise<void> {
    const source = await this.findEditableSource(user, id);
    if (source.isBuiltin) throw new BadRequestException('内置提示词源不能删除');
    await this.sourceRepo.remove(source);
  }

  /** 校验源存在且对当前用户可见（内置共享 / 自建私有）后返回 */
  private async findEditableSource(user: CurrentUser, id: string): Promise<PromptSource> {
    const source = await this.sourceRepo.findOne({ where: { id } });
    if (!source) throw new NotFoundException(`提示词源 #${id} 不存在`);
    if (source.userId !== null && source.userId !== user.id) {
      throw new ForbiddenException('只能操作自己的提示词源');
    }
    return source;
  }

  async fetchPrompts(user: CurrentUser, query: QueryPromptsDto): Promise<PromptListResponse> {
    const base = this.visibleItems(user);
    if (query.sourceId) base.andWhere('p.source_id = :sourceId', { sourceId: query.sourceId });
    const categories = await base
      .clone()
      .select('p.category', 'category')
      .distinct()
      .getRawMany<{ category: string }>();
    if (query.category && query.category !== ALL_PROMPTS_OPTION)
      base.andWhere('p.category = :category', { category: query.category });
    const keyword = query.keyword?.trim();
    if (keyword) {
      // LOCATE 将 %/_ 作为普通文本，避免 LIKE 通配符改变搜索语义。
      base.andWhere(
        '(LOCATE(:keyword, p.title) > 0 OR LOCATE(:keyword, p.prompt) > 0 OR LOCATE(:keyword, p.description) > 0 OR LOCATE(:keyword, CAST(p.tags AS CHAR)) > 0)',
        { keyword },
      );
    }
    const tagRows = await base.clone().select('p.tags').getMany();
    const tags = [...new Set(tagRows.flatMap((p) => p.tags))].sort();
    const selectedTags = (query.tag ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (selectedTags.length) {
      base.andWhere(
        `(${selectedTags.map((_, i) => `JSON_CONTAINS(p.tags, :tag${i})`).join(' OR ')})`,
        Object.fromEntries(selectedTags.map((t, i) => [`tag${i}`, JSON.stringify(t)])),
      );
    }
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const [items, total] = await base
      .orderBy('p.created_at', 'DESC')
      .addOrderBy('p.id', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return {
      items: items.map((p) => this.promptView(p, user)),
      total,
      tags,
      categories: categories.map((c) => c.category).sort(),
      canManage: await this.isManager(user),
    };
  }

  async findPrompt(user: CurrentUser, id: string): Promise<Prompt> {
    return this.promptView(await this.visiblePrompt(user, id), user);
  }

  async createPrompt(user: CurrentUser, dto: CreatePromptDto): Promise<Prompt> {
    await this.assertManager(user);
    const item = this.itemRepo.create({
      userId: null,
      sourceId: null,
      maintainerId: user.id,
      importKey: null,
      title: '',
      prompt: '',
      description: '',
      category: '其他创意',
      tags: [],
      metadata: {},
    });
    this.applyPromptChanges(item, dto);
    return this.promptView(await this.itemRepo.save(item), user);
  }

  async updatePrompt(user: CurrentUser, id: string, dto: UpdatePromptDto): Promise<Prompt> {
    const item = await this.visiblePrompt(user, id);
    if (item.userId === null && item.maintainerId !== user.id && user.role !== UserRole.ADMIN)
      throw new ForbiddenException('只能维护自己的提示词');
    this.applyPromptChanges(item, dto);
    // 条件更新不触碰 deleted_at，避免编辑请求晚于删除完成时恢复记录。
    const result = await this.itemRepo.update(
      { id: item.id, deletedAt: IsNull() },
      {
        title: item.title,
        prompt: item.prompt,
        description: item.description,
        category: item.category,
        tags: item.tags,
        metadata: item.metadata,
      },
    );
    if (!result.affected) throw new NotFoundException('提示词不存在');
    return this.findPrompt(user, item.id);
  }

  async removePrompt(user: CurrentUser, id: string): Promise<void> {
    const item = await this.visiblePrompt(user, id);
    if (item.userId === null && item.maintainerId !== user.id && user.role !== UserRole.ADMIN)
      throw new ForbiddenException('只能维护自己的提示词');
    await this.itemRepo.softDelete({ id: item.id });
  }

  async fetchSourcePrompts(user: CurrentUser, sourceId: string): Promise<Prompt[]> {
    await this.findEditableSource(user, sourceId);
    const items = await this.visibleItems(user)
      .andWhere('p.source_id = :sourceId', { sourceId })
      .orderBy('p.created_at', 'DESC')
      .getMany();
    return items.map((p) => this.promptView(p, user));
  }

  /** 旧 refresh 路由保留兼容，但只追加未导入项；不更新已有记录。 */
  async refreshSource(
    user: CurrentUser,
    sourceId: string,
    snapshot?: RawPrompt[],
  ): Promise<PromptSourceRefreshResult> {
    const source = await this.findEditableSource(user, sourceId);
    if (source.userId === null) await this.assertManager(user);
    const current = this.imports.get(source.id);
    if (current) return current;
    const running = this.importSource(source, snapshot, user.id).finally(() =>
      this.imports.delete(source.id),
    );
    this.imports.set(source.id, running);
    return running;
  }

  async refreshAllSources(user: CurrentUser): Promise<PromptSourceRefreshSummary> {
    const canManage = await this.isManager(user);
    const sources = (await this.listSources(user)).filter(
      (s) => s.isActive && (s.userId === user.id || canManage),
    );
    const results: PromptSourceRefreshResult[] = [];
    for (const source of sources) {
      try {
        results.push(await this.refreshSource(user, source.id));
      } catch {
        results.push(
          this.importStatuses.get(source.id) ?? {
            sourceId: source.id,
            sourceName: source.name,
            count: 0,
            lastSuccessAt: '',
            lastError: '导入失败，请重试',
            success: false,
            imported: 0,
            skipped: 0,
          },
        );
      }
    }
    return {
      results,
      total: results.reduce((n, r) => n + r.count, 0),
      successCount: results.filter((r) => r.success).length,
      failureCount: results.filter((r) => !r.success).length,
    };
  }

  async fetchSourceStatuses(user: CurrentUser): Promise<Record<string, PromptSourceStatus>> {
    const sources = await this.listSources(user);
    return Object.fromEntries(
      await Promise.all(
        sources.map(async (source) => {
          const latest = await this.itemRepo.findOne({
            where: { sourceId: source.id },
            order: { createdAt: 'DESC' },
            withDeleted: true,
          });
          return [
            source.id,
            {
              sourceId: source.id,
              count: await this.itemRepo.count({ where: { sourceId: source.id } }),
              lastSuccessAt:
                this.importStatuses.get(source.id)?.lastSuccessAt ||
                latest?.createdAt.toISOString() ||
                '',
              lastError: this.importStatuses.get(source.id)?.lastError || '',
            },
          ];
        }),
      ),
    );
  }

  /** CLI 和 HTTP 共用同一导入实现，失败可重试，唯一键在多实例并发下兜底。 */
  private async importSource(
    source: PromptSource,
    snapshot?: RawPrompt[],
    maintainerId?: string,
  ): Promise<PromptSourceRefreshResult> {
    let imported = 0;
    let skipped = 0;
    try {
      const items =
        snapshot ?? (await runPromptSource(source, { signal: AbortSignal.timeout(30_000) }));
      for (const raw of items) {
        const importKey = createHash('sha256').update(`${source.id}\n${raw.id}`).digest('hex');
        const existing = await this.itemRepo.findOne({ where: { importKey }, withDeleted: true });
        if (existing) {
          skipped++;
          continue;
        }
        const {
          id: _id,
          title,
          prompt,
          description,
          tags,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          ...metadata
        } = raw;
        void _id;
        void _createdAt;
        void _updatedAt;
        try {
          await this.itemRepo.save(
            this.itemRepo.create({
              userId: source.userId,
              maintainerId: maintainerId ?? null,
              sourceId: source.id,
              importKey,
              title,
              prompt,
              description: description || '',
              category: classifyPrompt(raw),
              tags: cleanTags(tags),
              metadata: {
                ...metadata,
                githubUrl: raw.sourceUrl || source.homepage,
                sourceName: source.name,
              },
            }),
          );
          imported++;
        } catch (error) {
          if ((error as { code?: string }).code === 'ER_DUP_ENTRY') skipped++;
          else throw error;
        }
      }
      const result = {
        sourceId: source.id,
        sourceName: source.name,
        count: await this.itemRepo.count({ where: { sourceId: source.id } }),
        lastSuccessAt: new Date().toISOString(),
        lastError: '',
        success: true,
        imported,
        skipped,
      };
      this.importStatuses.set(source.id, result);
      return result;
    } catch (error) {
      this.logger.warn(
        `提示词源「${source.name}」导入失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
      this.importStatuses.set(source.id, {
        sourceId: source.id,
        sourceName: source.name,
        count: await this.itemRepo.count({ where: { sourceId: source.id } }),
        lastSuccessAt: '',
        lastError: '导入失败，已保存的内容不受影响，可重试',
        success: false,
        imported,
        skipped,
      });
      throw new BadRequestException('提示词导入失败，已保存的内容不受影响，可重试');
    }
  }

  private visibleItems(user: CurrentUser): SelectQueryBuilder<PromptItem> {
    return this.itemRepo
      .createQueryBuilder('p')
      .where('(p.user_id IS NULL OR p.user_id = :userId)', { userId: user.id });
  }

  private async visiblePrompt(user: CurrentUser, id: string): Promise<PromptItem> {
    const item = await this.itemRepo.findOne({ where: { id } });
    if (!item || (item.userId !== null && item.userId !== user.id))
      throw new NotFoundException('提示词不存在');
    return item;
  }

  private async isManager(user: CurrentUser): Promise<boolean> {
    return (
      user.role === UserRole.ADMIN ||
      this.itemRepo.exists({
        where: { userId: IsNull(), maintainerId: user.id },
        withDeleted: true,
      })
    );
  }

  private async assertManager(user: CurrentUser): Promise<void> {
    if (!(await this.isManager(user))) throw new ForbiddenException('仅词库维护者可执行此操作');
  }

  /** 仅供服务器 CLI 初次导入，HTTP 控制器不暴露此入口；调用方选择具体维护者。 */
  async importBuiltinSnapshot(
    owner: CurrentUser,
    sourceId: string,
    snapshot: RawPrompt[],
  ): Promise<PromptSourceRefreshResult> {
    const source = await this.findEditableSource(owner, sourceId);
    if (!source.isBuiltin || source.userId !== null)
      throw new BadRequestException('初次导入仅支持内置公共源');
    return this.importSource(source, snapshot, owner.id);
  }

  private applyPromptChanges(item: PromptItem, dto: UpdatePromptDto): void {
    if (Object.values(dto).some((v) => v === null))
      throw new BadRequestException('提示词字段不能为 null');
    for (const key of ['title', 'prompt', 'description', 'category'] as const) {
      if (dto[key] !== undefined) item[key] = dto[key].trim();
    }
    if (!item.title || !item.prompt || !item.category || item.category === 'all')
      throw new BadRequestException('标题、正文和分类不能为空，分类不能使用 all');
    if (dto.tags !== undefined) item.tags = cleanTags(dto.tags);
    const {
      title: _title,
      prompt: _prompt,
      description: _description,
      category: _category,
      tags: _tags,
      ...metadata
    } = dto;
    void _title;
    void _prompt;
    void _description;
    void _category;
    void _tags;
    item.metadata = { ...item.metadata, ...metadata };
  }

  private promptView(item: PromptItem, user: CurrentUser): Prompt {
    return {
      coverUrl: '',
      referenceImageUrls: [],
      preview: '',
      ...item.metadata,
      id: item.id,
      title: item.title,
      prompt: item.prompt,
      description: item.description,
      tags: item.tags,
      category: item.category,
      sourceId: item.sourceId ?? '',
      sourceName: item.metadata.sourceName || '内部维护',
      githubUrl: item.metadata.githubUrl || '',
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      canEdit:
        item.userId === user.id ||
        (item.userId === null && (item.maintainerId === user.id || user.role === UserRole.ADMIN)),
    };
  }

  private toView(source: PromptSource): PromptSourceView {
    const { user: _user, ...rest } = source;
    void _user;
    return rest;
  }
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}
