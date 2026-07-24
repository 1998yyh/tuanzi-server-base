import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  ChannelVersions,
  PendingWrite,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
} from '@langchain/langgraph-checkpoint';
import { AgentCheckpoint } from '../entities/agent-checkpoint.entity';
import { AgentCheckpointWrite } from '../entities/agent-checkpoint-write.entity';

/**
 * LangGraph BaseCheckpointSaver 的 TypeORM（MySQL）适配器。
 *
 * 序列化：沿用基类默认 serde（JSON 序列化协议），dumpsTyped 产出 [type, Uint8Array]，
 * 字节统一 base64 编码后存 MEDIUMTEXT 列（与 MemorySaver 一样固定以 "json" 类型读回）。
 *
 * 实现参照官方 MemorySaver（@langchain/langgraph-checkpoint/dist/memory.js）。
 */
@Injectable()
export class TypeORMCheckpointer extends BaseCheckpointSaver {
  constructor(
    @InjectRepository(AgentCheckpoint)
    private readonly checkpointRepo: Repository<AgentCheckpoint>,
    @InjectRepository(AgentCheckpointWrite)
    private readonly writesRepo: Repository<AgentCheckpointWrite>,
  ) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = getCheckpointId(config);

    const row = checkpointId
      ? await this.checkpointRepo.findOne({
          where: { threadId, checkpointNs, checkpointId },
        })
      : await this.checkpointRepo.findOne({
          where: { threadId, checkpointNs },
          order: { id: 'DESC' }, // 自增主键即插入顺序，取最新快照
        });

    if (!row) return undefined;

    const [checkpoint, metadata] = await Promise.all([
      this.serde.loadsTyped('json', this.decode(row.checkpoint)),
      row.checkpointMetadata
        ? this.serde.loadsTyped('json', this.decode(row.checkpointMetadata))
        : Promise.resolve(undefined),
    ]);

    const writeRows = await this.writesRepo.find({
      where: {
        threadId,
        checkpointNs,
        checkpointId: row.checkpointId,
      },
      order: { taskId: 'ASC', idx: 'ASC' },
    });
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      writeRows.map(
        async (w): Promise<CheckpointPendingWrite> => [
          w.taskId,
          w.channel,
          await this.serde.loadsTyped('json', this.decode(w.value)),
        ],
      ),
    );

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (row.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.parentCheckpointId,
        },
      };
    }
    return tuple;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;
    const checkpointId = config.configurable?.checkpoint_id;
    const { limit, before, filter } = options ?? {};

    const where: Record<string, unknown> = {};
    if (threadId !== undefined) where.threadId = threadId;
    if (checkpointNs !== undefined) where.checkpointNs = checkpointNs;
    if (checkpointId !== undefined) where.checkpointId = checkpointId;

    // checkpoint_id 按字典序倒序（与 MemorySaver 的 localeCompare 排序语义一致）
    const rows = await this.checkpointRepo.find({
      where,
      order: { checkpointId: 'DESC' },
    });

    let remaining = limit;
    for (const row of rows) {
      if (remaining !== undefined && remaining <= 0) break;
      const beforeId = before?.configurable?.checkpoint_id;
      if (beforeId && row.checkpointId >= beforeId) continue;

      const metadata = row.checkpointMetadata
        ? await this.serde.loadsTyped('json', this.decode(row.checkpointMetadata))
        : undefined;
      if (filter && !Object.entries(filter).every(([k, v]) => metadata?.[k] === v)) {
        continue;
      }
      if (remaining !== undefined) remaining -= 1;

      const writeRows = await this.writesRepo.find({
        where: {
          threadId: row.threadId,
          checkpointNs: row.checkpointNs,
          checkpointId: row.checkpointId,
        },
        order: { taskId: 'ASC', idx: 'ASC' },
      });
      const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
        writeRows.map(
          async (w): Promise<CheckpointPendingWrite> => [
            w.taskId,
            w.channel,
            await this.serde.loadsTyped('json', this.decode(w.value)),
          ],
        ),
      );

      const tuple: CheckpointTuple = {
        config: {
          configurable: {
            thread_id: row.threadId,
            checkpoint_ns: row.checkpointNs,
            checkpoint_id: row.checkpointId,
          },
        },
        checkpoint: await this.serde.loadsTyped('json', this.decode(row.checkpoint)),
        metadata,
        pendingWrites,
      };
      if (row.parentCheckpointId) {
        tuple.parentConfig = {
          configurable: {
            thread_id: row.threadId,
            checkpoint_ns: row.checkpointNs,
            checkpoint_id: row.parentCheckpointId,
          },
        };
      }
      yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    if (threadId === undefined) {
      throw new Error('无法写入 checkpoint：RunnableConfig 缺少 configurable.thread_id');
    }

    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[, checkpointBytes], [, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);

    await this.checkpointRepo.upsert(
      {
        threadId,
        checkpointNs,
        checkpointId: checkpoint.id,
        parentCheckpointId: config.configurable?.checkpoint_id ?? null,
        checkpoint: this.encode(checkpointBytes),
        checkpointMetadata: this.encode(metadataBytes),
      },
      ['threadId', 'checkpointNs', 'checkpointId'],
    );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = config.configurable?.checkpoint_id;
    if (threadId === undefined || checkpointId === undefined) {
      throw new Error(
        '无法写入 writes：RunnableConfig 缺少 configurable.thread_id 或 checkpoint_id',
      );
    }

    await Promise.all(
      writes.map(async ([channel, value], arrayIdx) => {
        const idx = WRITES_IDX_MAP[channel] ?? arrayIdx;
        // 与 MemorySaver 一致：非负 idx 的写入只保留首条（幂等去重）
        if (idx >= 0) {
          const existing = await this.writesRepo.findOne({
            where: { threadId, checkpointNs, checkpointId, taskId, idx },
          });
          if (existing) return;
        }
        const [, valueBytes] = await this.serde.dumpsTyped(value);
        await this.writesRepo.insert({
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          idx,
          channel,
          value: this.encode(valueBytes),
        });
      }),
    );
  }

  /** 会话删除时调用：清理该 thread 的全部快照与写入 */
  async deleteThread(threadId: string): Promise<void> {
    await this.checkpointRepo.delete({ threadId });
    await this.writesRepo.delete({ threadId });
  }

  private encode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
  }

  private decode(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, 'base64'));
  }
}
