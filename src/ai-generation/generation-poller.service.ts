import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ModelCapability } from './entities/ai-channel.entity';
import { GenerationTask, GenerationTaskStatus } from './entities/generation-task.entity';
import { GenerationService } from './generation.service';

/** 单任务两次轮询的最小间隔（进程内记忆，重启后重新计） */
const MIN_POLL_INTERVAL_MS = 5_000;
/** 进行中任务的总时限，超时置 failed */
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
/** 单轮最多处理的任务数（串行处理，防止一轮拖垮 cron） */
const BATCH_SIZE = 50;

/**
 * 视频生成轮询：每 10s 扫一轮 pending/processing 任务，串行处理。
 * - PENDING 且没有 remoteTaskId：创建请求还在进行中，跳过（30min 未更新视为创建超时）
 * - PROCESSING：向渠道侧查询状态，成功则下载落盘并回填画布节点，失败则标记错误
 * - 任何任务超过 30min 未达终态 → failed「生成超时」
 * 单实例假设：多实例部署需加 leader 锁（当前不管）。
 */
@Injectable()
export class GenerationPollerService {
  private readonly logger = new Logger(GenerationPollerService.name);
  private running = false;
  private readonly lastPollAt = new Map<string, number>();

  constructor(
    @InjectRepository(GenerationTask)
    private readonly taskRepo: Repository<GenerationTask>,
    private readonly generationService: GenerationService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async pollPendingTasks(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tasks = await this.taskRepo.find({
        where: { status: In([GenerationTaskStatus.PENDING, GenerationTaskStatus.PROCESSING]) },
        order: { createdAt: 'ASC' },
        take: BATCH_SIZE,
      });
      for (const task of tasks) {
        try {
          await this.pollOne(task);
        } catch (error) {
          this.logger.error(
            `轮询任务 #${task.id} 失败：${error instanceof Error ? error.message : error}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pollOne(task: GenerationTask): Promise<void> {
    // 非视频的进行中任务（同步请求中途崩溃留下的行）：只做超时清理
    if (task.capability !== ModelCapability.VIDEO) {
      await this.failIfTimedOut(task);
      return;
    }
    // 创建请求还没写回 remoteTaskId（请求进行中）；30min 未更新视为创建超时
    if (!task.remoteTaskId) {
      if (Date.now() - task.updatedAt.getTime() > TASK_TIMEOUT_MS) {
        await this.failTask(task, '生成任务创建超时');
      }
      return;
    }
    const lastPollAt = this.lastPollAt.get(task.id) ?? 0;
    if (Date.now() - lastPollAt < MIN_POLL_INTERVAL_MS) return;
    this.lastPollAt.set(task.id, Date.now());

    if (await this.failIfTimedOut(task)) return;

    const state = await this.generationService.pollVideoTaskState(task);
    if (state.status === 'pending') return;
    this.lastPollAt.delete(task.id);
    if (state.status === 'failed') {
      await this.failTask(task, state.error);
      return;
    }
    try {
      await this.generationService.completeVideoTask(task, state);
    } catch (error) {
      await this.failTask(task, error instanceof Error ? error.message : '生成结果保存失败');
    }
  }

  /** 超时则置 failed 并返回 true */
  private async failIfTimedOut(task: GenerationTask): Promise<boolean> {
    if (Date.now() - task.createdAt.getTime() <= TASK_TIMEOUT_MS) return false;
    await this.failTask(task, '生成超时');
    return true;
  }

  private async failTask(task: GenerationTask, error: string): Promise<void> {
    this.lastPollAt.delete(task.id);
    await this.generationService.failTask(task, error);
    this.logger.warn(`任务 #${task.id} 失败：${error}`);
  }
}
