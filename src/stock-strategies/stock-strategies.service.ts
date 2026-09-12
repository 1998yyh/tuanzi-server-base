import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { StockStrategy } from './stock-strategy.entity';
import { validateDefinition } from './strategy-definition';
@Injectable()
export class StockStrategiesService {
  constructor(@InjectRepository(StockStrategy) private readonly repo: Repository<StockStrategy>) {}
  private name(value: string): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 80) throw new BadRequestException('策略名称必须为 1 到 80 个字符');
    return name;
  }
  private conflict(error: unknown): never {
    const duplicate = (value: unknown): boolean =>
      typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      value.code === 'ER_DUP_ENTRY';
    if (
      duplicate(error) ||
      (typeof error === 'object' &&
        error !== null &&
        'driverError' in error &&
        duplicate(error.driverError))
    ) {
      throw new ConflictException('策略名称已使用（含已删除记录），请使用其他名称');
    }
    throw error;
  }
  async create(
    userId: string,
    input: { name: string; definition: unknown },
  ): Promise<StockStrategy> {
    const name = this.name(input.name);
    const definition = validateDefinition(input.definition);
    const row = this.repo.create({
      userId,
      name,
      definition,
      version: 1,
      deletedAt: null,
      revisions: [
        {
          version: 1,
          name,
          definition: structuredClone(definition),
          savedAt: new Date().toISOString(),
        },
      ],
    });
    try {
      return await this.repo.save(row);
    } catch (error) {
      return this.conflict(error);
    }
  }
  async get(userId: string, id: string): Promise<StockStrategy> {
    const row = await this.repo.findOne({ where: { id, userId, deletedAt: IsNull() } });
    if (!row) throw new NotFoundException('策略不存在');
    return row;
  }
  async list(userId: string, page: number, limit: number) {
    const [items, total] = await this.repo
      .createQueryBuilder('strategy')
      .where('strategy.userId = :userId', { userId })
      .andWhere('strategy.deletedAt IS NULL')
      .orderBy('strategy.updatedAt', 'DESC')
      .addOrderBy('strategy.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
  private async write(row: StockStrategy, changes: Partial<StockStrategy>): Promise<void> {
    try {
      const result = await this.repo.update(
        { id: row.id, userId: row.userId, version: row.version, deletedAt: IsNull() },
        changes,
      );
      if (result.affected !== 1) throw new ConflictException('策略已被修改或删除，请刷新后重试');
    } catch (error) {
      this.conflict(error);
    }
  }
  async update(
    userId: string,
    id: string,
    input: { name: string; definition: unknown; version: number },
  ): Promise<StockStrategy> {
    const row = await this.get(userId, id);
    if (row.version !== input.version) throw new ConflictException('策略版本已变化，请刷新后重试');
    const name = this.name(input.name);
    const definition = validateDefinition(input.definition);
    const version = row.version + 1;
    const updatedAt = new Date();
    const changes = {
      name,
      definition,
      version,
      updatedAt,
      revisions: [
        ...row.revisions,
        {
          version,
          name,
          definition: structuredClone(definition),
          savedAt: updatedAt.toISOString(),
        },
      ],
    };
    await this.write(row, changes);
    return { ...row, ...changes };
  }
  async remove(userId: string, id: string, version: number): Promise<void> {
    const row = await this.get(userId, id);
    if (row.version !== version) throw new ConflictException('策略版本已变化，请刷新后重试');
    await this.write(row, { deletedAt: new Date(), version: row.version + 1 });
  }
}
