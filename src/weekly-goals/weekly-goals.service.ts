import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { WeeklyGoal, WeeklyGoalStatus } from './weekly-goals.entity';
import { CreateWeeklyGoalDto, QueryWeeklyGoalDto } from './dto/weekly-goal.dto';

@Injectable()
export class WeeklyGoalsService {
  constructor(
    @InjectRepository(WeeklyGoal)
    private weeklyGoalRepository: Repository<WeeklyGoal>,
  ) {}

  async create(userId: string, createDto: CreateWeeklyGoalDto): Promise<WeeklyGoal> {
    // 截止日期只认后端生成（创建 + 7 天），前端传了也没用——DTO 白名单直接挡掉。
    // 用 SQL 函数写 due_date：与 created_at 共用数据库时钟，避免应用层 JS Date
    // 经驱动时区转换后与 CURRENT_TIMESTAMP 生成的列产生偏差（docker 环境实测 +8h）。
    const result = await this.weeklyGoalRepository
      .createQueryBuilder()
      .insert()
      .values({
        ...createDto,
        userId,
        dueDate: () => 'DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 7 DAY)',
      })
      .execute();
    return this.findOwnedOne(userId, result.identifiers[0].id as string);
  }

  async findAll(userId: string, query: QueryWeeklyGoalDto): Promise<WeeklyGoal[]> {
    const status = query.status ?? WeeklyGoalStatus.ACTIVE;
    // 进行中按截止日升序（最紧急的在前），已完成按完成时间倒序（最近完成的在前）
    return this.weeklyGoalRepository.find({
      where: {
        userId,
        completedAt: status === WeeklyGoalStatus.ACTIVE ? IsNull() : Not(IsNull()),
      },
      order:
        status === WeeklyGoalStatus.ACTIVE
          ? { dueDate: 'ASC', createdAt: 'ASC' }
          : { completedAt: 'DESC' },
    });
  }

  async complete(userId: string, id: string): Promise<WeeklyGoal> {
    const goal = await this.findOwnedOne(userId, id);
    if (goal.completedAt) {
      throw new ConflictException(`周目标 #${id} 已完成，请勿重复操作`);
    }
    // 同 create：完成时间也走数据库时钟
    await this.weeklyGoalRepository
      .createQueryBuilder()
      .update()
      .set({ completedAt: () => 'CURRENT_TIMESTAMP' })
      .where('id = :id', { id })
      .execute();
    return this.findOwnedOne(userId, id);
  }

  async uncomplete(userId: string, id: string): Promise<WeeklyGoal> {
    const goal = await this.findOwnedOne(userId, id);
    if (!goal.completedAt) {
      throw new ConflictException(`周目标 #${id} 尚未完成，无法撤销`);
    }
    goal.completedAt = null;
    return this.weeklyGoalRepository.save(goal);
  }

  async remove(userId: string, id: string): Promise<void> {
    const goal = await this.findOwnedOne(userId, id);
    await this.weeklyGoalRepository.softRemove(goal);
  }

  /** 按 id + userId 查归属记录，查不到统一 404（不暴露记录是否存在） */
  private async findOwnedOne(userId: string, id: string): Promise<WeeklyGoal> {
    const goal = await this.weeklyGoalRepository.findOne({ where: { id, userId } });
    if (!goal) {
      throw new NotFoundException(`周目标 #${id} 不存在`);
    }
    return goal;
  }
}
