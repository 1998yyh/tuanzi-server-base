import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';
import { DailyReport, DailyReportType } from './daily-reports.entity';
import { CreateDailyReportDto, QueryDailyReportDto } from './dto/daily-report.dto';

@Injectable()
export class DailyReportsService {
  constructor(
    @InjectRepository(DailyReport)
    private dailyReportRepository: Repository<DailyReport>,
  ) {}

  async create(createDto: CreateDailyReportDto): Promise<DailyReport> {
    const report = this.dailyReportRepository.create(createDto);
    return this.dailyReportRepository.save(report);
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

  async update(id: string, updateDto: Partial<CreateDailyReportDto>): Promise<DailyReport> {
    const report = await this.findOne(id);
    Object.assign(report, updateDto);
    return this.dailyReportRepository.save(report);
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