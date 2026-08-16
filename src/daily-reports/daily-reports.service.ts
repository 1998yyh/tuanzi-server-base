import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { DailyReport, DailyReportType } from './daily-reports.entity';
import {
  CreateDailyReportDto,
  QueryDailyReportDto,
  UpdateDailyReportDto,
} from './dto/daily-report.dto';

@Injectable()
export class DailyReportsService {
  constructor(
    @InjectRepository(DailyReport)
    private dailyReportRepository: Repository<DailyReport>,
  ) {}

  /**
   * save 撞唯一索引（type+date）时转 409。
   * check-then-insert 的查重只是快速失败路径，并发竞态下的最终防线是 DB 唯一索引。
   */
  private async saveWithDupGuard<T>(promise: Promise<T>, date: string): Promise<T> {
    try {
      return await promise;
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        ((error.driverError as { errno?: number } | undefined)?.errno === 1062 ||
          (error.driverError as { code?: string } | undefined)?.code === 'ER_DUP_ENTRY')
      ) {
        throw new ConflictException(`${date} 该类型的日报已存在`);
      }
      throw error;
    }
  }

  async create(createDto: CreateDailyReportDto): Promise<DailyReport> {
    // type + date 有唯一索引，先查重以返回明确的 409 而非数据库 500
    const existing = await this.findByTypeAndDate(createDto.type, createDto.date);
    if (existing) {
      throw new ConflictException(`${createDto.date} 该类型的日报已存在`);
    }

    const report = this.dailyReportRepository.create(createDto);
    // 并发竞态兜底：DB 唯一索引冲突转 409（上方查重只是快速失败路径）
    return this.saveWithDupGuard(this.dailyReportRepository.save(report), createDto.date);
  }

  async findAll(query: QueryDailyReportDto) {
    const { type, date, page = 1, limit = 10 } = query;

    const qb = this.dailyReportRepository.createQueryBuilder('report');

    if (type) {
      qb.andWhere('report.type = :type', { type });
    }

    if (date) {
      qb.andWhere('report.date = :date', { date });
    }

    qb.orderBy('report.date', 'DESC')
      .addOrderBy('report.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string): Promise<DailyReport> {
    const report = await this.dailyReportRepository.findOne({ where: { id } });
    if (!report) {
      throw new NotFoundException(`日报 #${id} 不存在`);
    }
    return report;
  }

  async findByTypeAndDate(type: DailyReportType, date: string): Promise<DailyReport | null> {
    return this.dailyReportRepository.findOne({
      where: { type, date },
    });
  }

  async update(id: string, updateDto: UpdateDailyReportDto): Promise<DailyReport> {
    const report = await this.findOne(id);
    Object.assign(report, updateDto);
    // update 可能改 type/date 撞到其他行的唯一索引，同样转 409
    return this.saveWithDupGuard(this.dailyReportRepository.save(report), report.date);
  }

  /** 同 type+date 已存在则覆盖 title/content，否则新建（AI 自动生成日报场景） */
  async upsert(dto: CreateDailyReportDto): Promise<DailyReport> {
    const existing = await this.findByTypeAndDate(dto.type, dto.date);
    if (existing) {
      existing.title = dto.title;
      existing.content = dto.content;
      return this.saveWithDupGuard(this.dailyReportRepository.save(existing), dto.date);
    }
    return this.saveWithDupGuard(
      this.dailyReportRepository.save(this.dailyReportRepository.create(dto)),
      dto.date,
    );
  }

  async remove(id: string): Promise<void> {
    const report = await this.findOne(id);
    await this.dailyReportRepository.remove(report);
  }

  async getLatestByType(type: DailyReportType): Promise<DailyReport | null> {
    return this.dailyReportRepository.findOne({
      where: { type },
      order: { date: 'DESC' },
    });
  }

  async getDatesByType(type: DailyReportType): Promise<string[]> {
    const reports = await this.dailyReportRepository.find({
      where: { type },
      select: ['date'],
      order: { date: 'DESC' },
    });
    return reports.map((r) => r.date);
  }
}
