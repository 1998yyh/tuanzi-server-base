import { Injectable } from '@nestjs/common';

/**
 * 每会话执行锁（进程内 FIFO 互斥）。
 *
 * 存在意义：LangGraph checkpoint 的读改写 + 失败回滚（captureBaseline/
 * rollbackToBaseline）以「同一 conversationId 串行执行」为前提。此前该约束
 * 靠前端自觉（发送中禁止再发），后台任务（BackgroundTasksService）引入后
 * 后端必须自己保证——用户流式执行与后台任务写回同一会话时排队而非并发。
 *
 * 用法：const release = await lock.acquire(id); try { ... } finally { release(); }
 * 锁必须包住整个执行周期（含 baseline 捕获与回滚）。
 *
 * 单实例假设：多实例部署需换成 DB 行锁/分布式锁（与现有 poller 注释一致）。
 */
@Injectable()
export class ConversationExecutionLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** 排队获取会话锁，返回释放函数（必须在 finally 中调用） */
  async acquire(conversationId: string): Promise<() => void> {
    const prev = this.tails.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    // 挂到链尾：先到的执行完才轮到自己
    const tail = prev.then(() => current);
    this.tails.set(conversationId, tail);
    await prev;
    return () => {
      release();
      // 自己仍是链尾时清表（后续还有排队者则由它们持有更新后的 tail）
      if (this.tails.get(conversationId) === tail) {
        this.tails.delete(conversationId);
      }
    };
  }
}
