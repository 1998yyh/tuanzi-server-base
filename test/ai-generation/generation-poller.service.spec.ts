import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GenerationPollerService } from 'src/ai-generation/generation-poller.service';
import { GenerationService } from 'src/ai-generation/generation.service';
import {
  GenerationTask,
  GenerationTaskStatus,
} from 'src/ai-generation/entities/generation-task.entity';
import { ModelCapability } from 'src/ai-generation/entities/ai-channel.entity';

function makeTask(overrides: Partial<GenerationTask> = {}): GenerationTask {
  return {
    id: 'task-1',
    userId: 'user-1',
    channelId: 'ch-1',
    model: 'sora-2',
    capability: ModelCapability.VIDEO,
    status: GenerationTaskStatus.PROCESSING,
    prompt: '一只猫',
    params: { provider: 'openai' },
    remoteTaskId: 'video-123',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as GenerationTask;
}

describe('GenerationPollerService', () => {
  let poller: GenerationPollerService;
  let taskRepo: { find: jest.Mock };
  let generationService: {
    pollVideoTaskState: jest.Mock;
    completeVideoTask: jest.Mock;
    failTask: jest.Mock;
  };

  beforeEach(async () => {
    taskRepo = { find: jest.fn(async () => []) };
    generationService = {
      pollVideoTaskState: jest.fn(),
      completeVideoTask: jest.fn(async () => undefined),
      failTask: jest.fn(async () => undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GenerationPollerService,
        { provide: getRepositoryToken(GenerationTask), useValue: taskRepo },
        { provide: GenerationService, useValue: generationService },
      ],
    }).compile();
    poller = module.get(GenerationPollerService);
  });

  it('pending 且无 remoteTaskId（创建请求进行中）：跳过不处理', async () => {
    taskRepo.find.mockResolvedValue([
      makeTask({ status: GenerationTaskStatus.PENDING, remoteTaskId: null }),
    ]);
    await poller.pollPendingTasks();
    expect(generationService.pollVideoTaskState).not.toHaveBeenCalled();
    expect(generationService.failTask).not.toHaveBeenCalled();
  });

  it('轮询 pending 状态：不改动任务', async () => {
    taskRepo.find.mockResolvedValue([makeTask()]);
    generationService.pollVideoTaskState.mockResolvedValue({ status: 'pending' });
    await poller.pollPendingTasks();
    expect(generationService.completeVideoTask).not.toHaveBeenCalled();
    expect(generationService.failTask).not.toHaveBeenCalled();
  });

  it('轮询成功：下载落盘并完成任务', async () => {
    const task = makeTask();
    taskRepo.find.mockResolvedValue([task]);
    generationService.pollVideoTaskState.mockResolvedValue({
      status: 'succeeded',
      url: 'https://cdn.com/v.mp4',
    });
    await poller.pollPendingTasks();
    expect(generationService.completeVideoTask).toHaveBeenCalledWith(task, {
      status: 'succeeded',
      url: 'https://cdn.com/v.mp4',
    });
  });

  it('轮询失败：标记任务失败', async () => {
    taskRepo.find.mockResolvedValue([makeTask()]);
    generationService.pollVideoTaskState.mockResolvedValue({
      status: 'failed',
      error: '内容审核未通过',
    });
    await poller.pollPendingTasks();
    expect(generationService.failTask).toHaveBeenCalledWith(expect.anything(), '内容审核未通过');
  });

  it('结果下载保存异常：任务置 failed', async () => {
    taskRepo.find.mockResolvedValue([makeTask()]);
    generationService.pollVideoTaskState.mockResolvedValue({ status: 'succeeded', url: null });
    generationService.completeVideoTask.mockRejectedValue(new Error('磁盘写入失败'));
    await poller.pollPendingTasks();
    expect(generationService.failTask).toHaveBeenCalledWith(expect.anything(), '磁盘写入失败');
  });

  it('超过 30 分钟未达终态：置 failed「生成超时」，不再轮询', async () => {
    taskRepo.find.mockResolvedValue([
      makeTask({ createdAt: new Date(Date.now() - 31 * 60 * 1000) }),
    ]);
    await poller.pollPendingTasks();
    expect(generationService.pollVideoTaskState).not.toHaveBeenCalled();
    expect(generationService.failTask).toHaveBeenCalledWith(expect.anything(), '生成超时');
  });

  it('单任务最小轮询间隔 5s：同一轮内重复出现不重复请求', async () => {
    taskRepo.find.mockResolvedValue([makeTask()]);
    generationService.pollVideoTaskState.mockResolvedValue({ status: 'pending' });
    await poller.pollPendingTasks();
    await poller.pollPendingTasks();
    expect(generationService.pollVideoTaskState).toHaveBeenCalledTimes(1);
  });

  it('单任务异常不影响同轮其他任务', async () => {
    taskRepo.find.mockResolvedValue([
      makeTask({ id: 'task-a' }),
      makeTask({ id: 'task-b', remoteTaskId: 'video-b' }),
    ]);
    generationService.pollVideoTaskState
      .mockRejectedValueOnce(new Error('网络抖动'))
      .mockResolvedValueOnce({ status: 'pending' });
    await poller.pollPendingTasks();
    expect(generationService.pollVideoTaskState).toHaveBeenCalledTimes(2);
  });

  it('非视频的进行中任务只做超时清理', async () => {
    taskRepo.find.mockResolvedValue([
      makeTask({
        capability: ModelCapability.IMAGE,
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      }),
    ]);
    await poller.pollPendingTasks();
    expect(generationService.pollVideoTaskState).not.toHaveBeenCalled();
    expect(generationService.failTask).toHaveBeenCalledWith(expect.anything(), '生成超时');
  });
});
