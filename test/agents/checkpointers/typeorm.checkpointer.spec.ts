import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RunnableConfig } from '@langchain/core/runnables';
import { Checkpoint, CheckpointMetadata, emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { TypeORMCheckpointer } from 'src/agents/checkpointers/typeorm.checkpointer';
import { AgentCheckpoint } from 'src/agents/entities/agent-checkpoint.entity';
import { AgentCheckpointWrite } from 'src/agents/entities/agent-checkpoint-write.entity';

describe('TypeORMCheckpointer', () => {
  let checkpointer: TypeORMCheckpointer;
  let checkpointRepo: jest.Mocked<Repository<AgentCheckpoint>>;
  let writesRepo: jest.Mocked<Repository<AgentCheckpointWrite>>;

  const threadId = 'conv-uuid-1';
  const config: RunnableConfig = {
    configurable: { thread_id: threadId, checkpoint_ns: '' },
  };

  const buildCheckpoint = (id: string): Checkpoint => ({
    ...emptyCheckpoint(),
    id,
  });

  const metadata: CheckpointMetadata = {
    source: 'input',
    step: 0,
    parents: {},
  } as CheckpointMetadata;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TypeORMCheckpointer,
        {
          provide: getRepositoryToken(AgentCheckpoint),
          useValue: { findOne: jest.fn(), find: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
        },
        {
          provide: getRepositoryToken(AgentCheckpointWrite),
          useValue: { findOne: jest.fn(), find: jest.fn(), insert: jest.fn(), delete: jest.fn() },
        },
      ],
    }).compile();

    checkpointer = module.get(TypeORMCheckpointer);
    checkpointRepo = module.get(getRepositoryToken(AgentCheckpoint));
    writesRepo = module.get(getRepositoryToken(AgentCheckpointWrite));
  });

  describe('put / getTuple', () => {
    it('put 应该序列化后写入，getTuple 应该还原出相同内容', async () => {
      const checkpoint = buildCheckpoint('cp-1');
      let savedRow: Partial<AgentCheckpoint> = {};
      checkpointRepo.upsert.mockImplementation(async (row) => {
        savedRow = row as Partial<AgentCheckpoint>;
        return {} as never;
      });
      writesRepo.find.mockResolvedValue([]);

      const newConfig = await checkpointer.put(config, checkpoint, metadata, {});

      expect(newConfig.configurable?.checkpoint_id).toBe('cp-1');
      expect(checkpointRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId,
          checkpointNs: '',
          checkpointId: 'cp-1',
        }),
        ['threadId', 'checkpointNs', 'checkpointId'],
      );

      // getTuple 指定 checkpoint_id 读取
      checkpointRepo.findOne.mockResolvedValue(savedRow as AgentCheckpoint);
      const tuple = await checkpointer.getTuple({
        configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-1' },
      });

      expect(tuple?.checkpoint.id).toBe('cp-1');
      expect(tuple?.metadata).toEqual(metadata);
      expect(tuple?.pendingWrites).toEqual([]);
    });

    it('不指定 checkpoint_id 时应该按自增主键取最新快照', async () => {
      checkpointRepo.findOne.mockResolvedValue(null);

      await checkpointer.getTuple(config);

      expect(checkpointRepo.findOne).toHaveBeenCalledWith({
        where: { threadId, checkpointNs: '' },
        order: { id: 'DESC' },
      });
    });

    it('快照不存在时应该返回 undefined', async () => {
      checkpointRepo.findOne.mockResolvedValue(null);
      expect(await checkpointer.getTuple(config)).toBeUndefined();
    });

    it('put 缺少 thread_id 应该抛错', async () => {
      await expect(
        checkpointer.put({ configurable: {} }, buildCheckpoint('cp-x'), metadata, {}),
      ).rejects.toThrow('无法写入 checkpoint');
    });

    it('有 parent_checkpoint_id 时 getTuple 应该返回 parentConfig', async () => {
      const checkpoint = buildCheckpoint('cp-2');
      checkpointRepo.upsert.mockResolvedValue({} as never);
      writesRepo.find.mockResolvedValue([]);

      const parentConfig: RunnableConfig = {
        configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-1' },
      };
      await checkpointer.put(parentConfig, checkpoint, metadata, {});

      const savedRow = checkpointRepo.upsert.mock.calls[0][0] as Partial<AgentCheckpoint>;
      expect(savedRow.parentCheckpointId).toBe('cp-1');

      checkpointRepo.findOne.mockResolvedValue(savedRow as AgentCheckpoint);
      const tuple = await checkpointer.getTuple({
        configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-2' },
      });
      expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe('cp-1');
    });
  });

  describe('putWrites', () => {
    const writeConfig: RunnableConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-1' },
    };

    it('应该序列化每条写入并插入', async () => {
      writesRepo.findOne.mockResolvedValue(null);
      writesRepo.insert.mockResolvedValue({} as never);

      await checkpointer.putWrites(writeConfig, [['messages', 'hello']], 'task-1');

      expect(writesRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId,
          checkpointId: 'cp-1',
          taskId: 'task-1',
          idx: 0,
          channel: 'messages',
        }),
      );
    });

    it('非负 idx 的重复写入应该幂等跳过', async () => {
      writesRepo.findOne.mockResolvedValue({ id: 1 } as AgentCheckpointWrite);

      await checkpointer.putWrites(writeConfig, [['messages', 'hello']], 'task-1');

      expect(writesRepo.insert).not.toHaveBeenCalled();
    });

    it('写入应该能被 getTuple 作为 pendingWrites 读回', async () => {
      writesRepo.findOne.mockResolvedValue(null);
      const inserted: Partial<AgentCheckpointWrite>[] = [];
      writesRepo.insert.mockImplementation(async (row) => {
        inserted.push(row as Partial<AgentCheckpointWrite>);
        return {} as never;
      });
      await checkpointer.putWrites(writeConfig, [['messages', 'hello']], 'task-1');

      // 伪造 checkpoint 行 + 写入行
      checkpointRepo.findOne.mockResolvedValue({
        checkpoint: Buffer.from(
          new TextEncoder().encode(JSON.stringify(buildCheckpoint('cp-1'))),
        ).toString('base64'),
        checkpointMetadata: null,
        checkpointId: 'cp-1',
      } as AgentCheckpoint);
      writesRepo.find.mockResolvedValue(inserted as AgentCheckpointWrite[]);

      const tuple = await checkpointer.getTuple(writeConfig);
      expect(tuple?.pendingWrites).toEqual([['task-1', 'messages', 'hello']]);
    });
  });

  describe('list', () => {
    it('应该按 checkpoint_id 倒序遍历并应用 limit', async () => {
      const mkRow = (id: string) =>
        ({
          threadId,
          checkpointNs: '',
          checkpointId: id,
          parentCheckpointId: null,
          checkpoint: Buffer.from(
            new TextEncoder().encode(JSON.stringify(buildCheckpoint(id))),
          ).toString('base64'),
          checkpointMetadata: null,
        }) as AgentCheckpoint;
      checkpointRepo.find.mockResolvedValue([mkRow('cp-2'), mkRow('cp-1')]);
      writesRepo.find.mockResolvedValue([]);

      const ids: string[] = [];
      for await (const tuple of checkpointer.list(config, { limit: 1 })) {
        ids.push(tuple.checkpoint.id);
      }

      expect(ids).toEqual(['cp-2']);
    });
  });

  describe('deleteThread', () => {
    it('应该删除该 thread 的全部快照与写入', async () => {
      checkpointRepo.delete.mockResolvedValue({} as never);
      writesRepo.delete.mockResolvedValue({} as never);

      await checkpointer.deleteThread(threadId);

      expect(checkpointRepo.delete).toHaveBeenCalledWith({ threadId });
      expect(writesRepo.delete).toHaveBeenCalledWith({ threadId });
    });
  });
});
