// Adapted from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/services/api/prompts.ts。改造点：localforage → 进程内 Map 缓存（1h SWR）；
// 源列表从前端 store → prompt_sources 表（内置源 user_id=null 共享 + 用户自建源）
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User } from '../users/users.entity';
import { PromptSource, PromptSourceView } from './prompt-source.entity';
import { DEFAULT_PROMPT_SOURCES } from './lib/prompt-presets';
import { RawPrompt, runPromptSource } from './lib/prompt-normalize';
import { CreatePromptSourceDto, UpdatePromptSourceDto } from './dto/prompt-source.dto';
import { QueryPromptsDto } from './dto/query-prompts.dto';

type CurrentUser = Omit<User, 'password'>;

export type Prompt = RawPrompt & {
  sourceId: string;
  category: string;
  githubUrl: string;
};

export const ALL_PROMPTS_OPTION = 'all';

export type PromptListResponse = {
  items: Prompt[];
  tags: string[];
  categories: string[];
  total: number;
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
};

export type PromptSourceRefreshSummary = {
  results: PromptSourceRefreshResult[];
  total: number;
  successCount: number;
  failureCount: number;
};

type SourceCache = PromptSourceStatus & {
  items: Prompt[];
  fetchedAt: number;
  signature: string;
};

const CACHE_TTL_MS = 1000 * 60 * 60;
const FETCH_TIMEOUT_MS = 30_000;
/** 失败退避窗口：距上次失败不足该时长时不触发重新抓取（连续失败不再每请求一抓） */
const FETCH_BACKOFF_MS = 5 * 60 * 1000;
/** refreshAllSources 单批并发数（串行批次，避免一次性打满全部源） */
const REFRESH_BATCH_SIZE = 4;
/** 单个用户自建提示词源上限 */
const MAX_USER_SOURCES = 50;

/**
 * 提示词库：源配置落库，内容走 HTTP 抓取 + 进程内 1h SWR 缓存。
 * 缓存在重启后清空（首访重新抓取），多实例部署各自缓存（可接受）。
 */
@Injectable()
export class PromptsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PromptsService.name);
  private readonly cache = new Map<string, SourceCache>();
  private readonly loadingSources = new Map<string, Promise<PromptSourceRefreshResult>>();
  /**
   * 失败退避记忆（sourceId → 最近一次失败时间戳，进程内）。
   * 多实例局限：各实例各自记忆，重启后清空——与内容缓存同生命周期，可接受。
   */
  private readonly lastFailedAt = new Map<string, number>();

  constructor(
    @InjectRepository(PromptSource)
    private readonly sourceRepo: Repository<PromptSource>,
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
    this.cache.delete(id);
    // 配置变更后重置失败退避，允许立即重新抓取
    this.lastFailedAt.delete(id);
    return this.toView(saved);
  }

  async removeSource(user: CurrentUser, id: string): Promise<void> {
    const source = await this.findEditableSource(user, id);
    if (source.isBuiltin) throw new BadRequestException('内置提示词源不能删除');
    await this.sourceRepo.remove(source);
    this.cache.delete(id);
    this.lastFailedAt.delete(id);
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

  // ---------------------------------------------------------------------------
  // 提示词查询（SWR 缓存 + 过滤分页）
  // ---------------------------------------------------------------------------

  async fetchPrompts(user: CurrentUser, query: QueryPromptsDto): Promise<PromptListResponse> {
    const sources = await this.enabledSources(user);
    const items = await this.getAllPrompts(sources);
    const keyword = (query.keyword ?? '').trim().toLowerCase();
    const tags = (query.tag ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const category = query.category ?? ALL_PROMPTS_OPTION;
    const page = Math.max(1, query.page);
    const pageSize = Math.max(1, Math.min(100, query.pageSize));

    const withoutTagFilter = filterPrompts(items, { keyword, category, tags: [] });
    const filtered = filterPrompts(items, { keyword, category, tags });

    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      tags: collectTags(withoutTagFilter),
      categories: sources.map((s) => s.name),
      total: filtered.length,
    };
  }

  async fetchSourcePrompts(user: CurrentUser, sourceId: string): Promise<Prompt[]> {
    const source = await this.findEditableSource(user, sourceId);
    return this.getSourcePrompts(source);
  }

  async refreshSource(user: CurrentUser, sourceId: string): Promise<PromptSourceRefreshResult> {
    const source = await this.findEditableSource(user, sourceId);
    const result = await this.getOrStartRefresh(source);
    if (!result.success) throw new BadRequestException(result.lastError);
    return result;
  }

  async refreshAllSources(user: CurrentUser): Promise<PromptSourceRefreshSummary> {
    const sources = await this.enabledSources(user);
    // 分批并发（每批 4 个、串行批次），避免全量 Promise.all 一次性打满所有源
    const results: PromptSourceRefreshResult[] = [];
    for (let index = 0; index < sources.length; index += REFRESH_BATCH_SIZE) {
      const batch = sources.slice(index, index + REFRESH_BATCH_SIZE);
      results.push(...(await Promise.all(batch.map((s) => this.getOrStartRefresh(s)))));
    }
    return summarizeRefresh(results);
  }

  async fetchSourceStatuses(user: CurrentUser): Promise<Record<string, PromptSourceStatus>> {
    const sources = await this.listSources(user);
    const entries = sources.map((source) => {
      const cache = this.cache.get(source.id);
      return [
        source.id,
        {
          sourceId: source.id,
          count: cache?.items?.length || 0,
          lastSuccessAt: cache?.lastSuccessAt || '',
          lastError: cache?.lastError || '',
        },
      ] as const;
    });
    return Object.fromEntries(entries);
  }

  // ---------------------------------------------------------------------------
  // 缓存内部
  // ---------------------------------------------------------------------------

  private async enabledSources(user: CurrentUser): Promise<PromptSource[]> {
    const sources = await this.sourceRepo.find({
      where: [
        { userId: IsNull(), isActive: true },
        { userId: user.id, isActive: true },
      ],
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return sources;
  }

  private async getSourcePrompts(source: PromptSource): Promise<Prompt[]> {
    const cached = this.cache.get(source.id);
    if (cached) {
      if (this.isSourceStale(cached, source)) {
        void this.getOrStartRefresh(source).catch(() => undefined);
      }
      return cached.items;
    }
    const result = await this.getOrStartRefresh(source);
    if (!result.success) throw new BadRequestException(result.lastError);
    return this.cache.get(source.id)?.items || [];
  }

  /**
   * 缓存是否过期：签名变化 / 距上次成功超过 CACHE_TTL_MS；
   * 距上次失败不足 FETCH_BACKOFF_MS 时处于退避期，即使超 TTL 也不触发重新抓取。
   */
  private isSourceStale(cached: SourceCache, source: PromptSource): boolean {
    if (cached.signature !== sourceSignature(source)) return true;
    const lastFailedAt = this.lastFailedAt.get(source.id) ?? 0;
    if (lastFailedAt > 0 && Date.now() - lastFailedAt < FETCH_BACKOFF_MS) return false;
    return Date.now() - cached.fetchedAt >= CACHE_TTL_MS;
  }

  private async getAllPrompts(sources: PromptSource[]): Promise<Prompt[]> {
    const settled = await Promise.all(
      sources.map(async (source) => {
        try {
          return await this.getSourcePrompts(source);
        } catch {
          return [];
        }
      }),
    );
    return settled.flat();
  }

  private getOrStartRefresh(source: PromptSource): Promise<PromptSourceRefreshResult> {
    const current = this.loadingSources.get(source.id);
    if (current) return current;
    const loading = this.refreshSourceRecord(source).finally(() =>
      this.loadingSources.delete(source.id),
    );
    this.loadingSources.set(source.id, loading);
    return loading;
  }

  private async refreshSourceRecord(source: PromptSource): Promise<PromptSourceRefreshResult> {
    const previous = this.cache.get(source.id);
    try {
      const items = withSourceMeta(
        source,
        await runPromptSource(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      );
      const lastSuccessAt = new Date().toISOString();
      this.lastFailedAt.delete(source.id);
      this.cache.set(source.id, {
        sourceId: source.id,
        items,
        count: items.length,
        fetchedAt: Date.now(),
        lastSuccessAt,
        lastError: '',
        signature: sourceSignature(source),
      });
      return {
        sourceId: source.id,
        sourceName: source.name,
        count: items.length,
        lastSuccessAt,
        lastError: '',
        success: true,
      };
    } catch (error) {
      // lastError 只写脱敏后的通用文案；原始细节（含状态码/DNS/TLS）挂在 error.cause 上记日志
      const lastError = error instanceof Error ? error.message : String(error);
      const detail = error instanceof Error ? (error.cause ?? error.message) : String(error);
      this.lastFailedAt.set(source.id, Date.now());
      this.cache.set(source.id, {
        sourceId: source.id,
        items: previous?.items || [],
        count: previous?.items?.length || 0,
        fetchedAt: previous?.fetchedAt || 0,
        lastSuccessAt: previous?.lastSuccessAt || '',
        lastError,
        signature: previous?.signature || sourceSignature(source),
      });
      this.logger.warn(`提示词源「${source.name}」刷新失败：${detail}`);
      return {
        sourceId: source.id,
        sourceName: source.name,
        count: previous?.items?.length || 0,
        lastSuccessAt: previous?.lastSuccessAt || '',
        lastError,
        success: false,
      };
    }
  }

  private toView(source: PromptSource): PromptSourceView {
    const { user: _user, ...rest } = source;
    void _user;
    return rest;
  }
}

// ---------------------------------------------------------------------------
// 纯函数（移植自 prompts.ts）
// ---------------------------------------------------------------------------

function sourceSignature(source: PromptSource): string {
  const value = `${source.name}\n${source.url}\n${source.homepage}`;
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return `${value.length}:${hash}`;
}

function withSourceMeta(source: PromptSource, items: RawPrompt[]): Prompt[] {
  return items.map((item) => ({
    ...item,
    description: item.description || '',
    referenceImageUrls: Array.isArray(item.referenceImageUrls) ? item.referenceImageUrls : [],
    sourceId: source.id,
    category: source.name,
    githubUrl: item.sourceUrl || source.homepage,
  }));
}

function summarizeRefresh(results: PromptSourceRefreshResult[]): PromptSourceRefreshSummary {
  return {
    results,
    total: results.reduce((total, item) => total + item.count, 0),
    successCount: results.filter((item) => item.success).length,
    failureCount: results.filter((item) => !item.success).length,
  };
}

function filterPrompts(
  items: Prompt[],
  options: { keyword: string; category: string; tags: string[] },
) {
  return items.filter((item) => {
    if (isActiveOption(options.category) && item.category !== options.category) return false;
    if (options.tags.length && !options.tags.some((tag) => item.tags.includes(tag))) return false;
    if (!options.keyword) return true;
    return [item.title, item.prompt, item.description, item.category, ...item.tags]
      .join(' ')
      .toLowerCase()
      .includes(options.keyword);
  });
}

function collectTags(items: Prompt[]): string[] {
  return Array.from(new Set(items.flatMap((item) => item.tags).filter(Boolean)));
}

function isActiveOption(value: string): boolean {
  return Boolean(value) && value !== ALL_PROMPTS_OPTION;
}
