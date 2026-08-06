import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ScheduledTasksService } from 'src/agents/scheduled-tasks/scheduled-tasks.service';
import { ScheduledTask } from 'src/agents/scheduled-tasks/scheduled-task.entity';
import { AgentConfig } from 'src/agents/entities/agent-config.entity';
import { Conversation, ConversationStatus } from 'src/agents/entities/conversation.entity';
import { Message, MessageRole } from 'src/agents/entities/message.entity';
import { AgentExecutorService } from 'src/agents/agent-executor.service';
import { ToolRegistryService } from 'src/agents/tools/tool-registry.service';
import { DailyReportsService } from 'src/daily-reports/daily-reports.service';
import { DailyReportType } from 'src/daily-reports/daily-reports.entity';

// CronJob 不能真启动（测试环境没有真实调度），mock 掉
// 注：@nestjs/schedule v6 不再 re-export CronJob，service 从 cron 包导入，故 mock 'cron'
jest.mock('cron', () => {
  const actual = jest.requireActual('cron');
  return {
    ...actual,
    CronJob: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn() })),
  };
});

describe('ScheduledTasksService', () => {
  let service: ScheduledTasksService;
  let taskRepo: jest.Mocked<Repository<ScheduledTask>>;
  let agentRepo: jest.Mocked<Repository<AgentConfig>>;
  let conversationRepo: jest.Mocked<Repository<Conversation>>;
  let messageRepo: jest.Mocked<Repository<Message>>;
  let schedulerRegistry: Record<string, jest.Mock>;
  let agentExecutor: Record<string, jest.Mock>;
  let dailyReportsService: Record<string, jest.Mock>;
  let toolRegistry: Record<string, jest.Mock>;

  const baseTask: ScheduledTask = {
    id: 'task-1',
    agentConfig: null as never,
    agentConfigId: 'agent-1',
    reportType: DailyReportType.AI,
    cronExpression: '0 8 * * *',
    description: '生成 AI 日报',
    isActive: true,
    lastRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const agentConfig = { id: 'agent-1', isActive: true } as AgentConfig;

  beforeEach(async () => {
    schedulerRegistry = {
      addCronJob: jest.fn(),
      deleteCronJob: jest.fn(),
      doesExist: jest.fn().mockReturnValue(false),
    };
    agentExecutor = { runBatch: jest.fn().mockResolvedValue([]) };
    dailyReportsService = { upsert: jest.fn() };
    toolRegistry = { registerAgentScopedTool: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTasksService,
        {
          provide: getRepositoryToken(ScheduledTask),
          useValue: {
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => ({ id: 'task-1', ...v })),
            find: jest.fn(),
            findOne: jest.fn(),
            remove: jest.fn(async (v) => v),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(AgentConfig),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: {
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => ({ id: 'conv-1', ...v })),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Message),
          useValue: {
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => v),
          },
        },
        { provide: SchedulerRegistry, useValue: schedulerRegistry },
        { provide: AgentExecutorService, useValue: agentExecutor },
        { provide: DailyReportsService, useValue: dailyReportsService },
        { provide: ToolRegistryService, useValue: toolRegistry },
      ],
    }).compile();

    service = module.get(ScheduledTasksService);
    taskRepo = module.get(getRepositoryToken(ScheduledTask));
    agentRepo = module.get(getRepositoryToken(AgentConfig));
    conversationRepo = module.get(getRepositoryToken(Conversation));
    messageRepo = module.get(getRepositoryToken(Message));
    jest.clearAllMocks();
  });

  describe('createTask', () => {
    const params = { cronExpression: '0 8 * * *', reportType: 'ai', description: '生成 AI 日报' };

    it('非法 cron 表达式应抛 400', async () => {
      await expect(
        service.createTask('agent-1', { ...params, cronExpression: 'not a cron' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('间隔小于 1 小时的表达式应抛 400', async () => {
      await expect(
        service.createTask('agent-1', { ...params, cronExpression: '*/30 * * * *' }),
      ).rejects.toThrow('任务间隔不能少于 1 小时');
    });

    it('非法 reportType 应抛 400', async () => {
      await expect(
        service.createTask('agent-1', { ...params, reportType: 'crypto' }),
      ).rejects.toThrow('日报类型必须是 ai 或 stock');
    });

    it('空描述应抛 400', async () => {
      await expect(service.createTask('agent-1', { ...params, description: '' })).rejects.toThrow(
        '描述不能为空',
      );
    });

    it('同 Agent 同类型已有活跃任务应抛 409', async () => {
      taskRepo.findOne.mockResolvedValue({ ...baseTask });

      await expect(service.createTask('agent-1', params)).rejects.toThrow(ConflictException);
      await expect(service.createTask('agent-1', params)).rejects.toThrow(
        '该 Agent 已有 AI 日报定时任务，请先删除旧任务',
      );
    });

    it('成功创建应落库、注册 cron job 并返回下次执行时间', async () => {
      taskRepo.findOne.mockResolvedValue(null);

      const result = await service.createTask('agent-1', params);

      expect(taskRepo.save).toHaveBeenCalled();
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith('task-1', expect.anything());
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-1');
      expect(result.nextRunAt).toBeTruthy();
    });
  });

  describe('listTasks', () => {
    it('应返回该 Agent 的全部任务（含已停用）', async () => {
      taskRepo.find.mockResolvedValue([baseTask]);

      const result = await service.listTasks('agent-1');

      expect(taskRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agentConfigId: 'agent-1' } }),
      );
      expect(result.tasks).toHaveLength(1);
    });
  });

  describe('deleteTask', () => {
    it('任务不存在或不属于该 Agent 应抛 400', async () => {
      taskRepo.findOne.mockResolvedValue(null);

      await expect(service.deleteTask('agent-1', 'task-x')).rejects.toThrow(
        '任务不存在或无权限删除',
      );
    });

    it('成功删除应取消 cron 注册并硬删除记录', async () => {
      taskRepo.findOne.mockResolvedValue({ ...baseTask });
      schedulerRegistry.doesExist.mockReturnValue(true);

      const result = await service.deleteTask('agent-1', 'task-1');

      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('task-1');
      expect(taskRepo.remove).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('writeDailyReport', () => {
    const params = { type: 'ai', title: 'AI日报', content: '# 内容' };

    it('非法类型应抛 400', async () => {
      await expect(service.writeDailyReport({ ...params, type: 'x' })).rejects.toThrow(
        '日报类型必须是 ai 或 stock',
      );
    });

    it('空标题 / 空内容应抛 400', async () => {
      await expect(service.writeDailyReport({ ...params, title: '' })).rejects.toThrow(
        '标题不能为空',
      );
      await expect(service.writeDailyReport({ ...params, content: '' })).rejects.toThrow(
        '内容不能为空',
      );
    });

    it('非法日期格式应抛 400', async () => {
      await expect(service.writeDailyReport({ ...params, date: '2026/07/28' })).rejects.toThrow(
        '日期格式错误，应为 YYYY-MM-DD',
      );
      await expect(service.writeDailyReport({ ...params, date: '2026-13-01' })).rejects.toThrow(
        '日期格式错误，应为 YYYY-MM-DD',
      );
    });

    it('未传日期应默认今天（Asia/Shanghai）并调用 upsert', async () => {
      dailyReportsService.upsert.mockResolvedValue({ id: 'report-1' });

      const result = await service.writeDailyReport(params);

      const dto = dailyReportsService.upsert.mock.calls[0][0] as { date: string };
      expect(dto.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result).toEqual({ success: true, id: 'report-1' });
    });
  });

  describe('onModuleInit', () => {
    it('应注册 4 个 Agent 作用域工具', () => {
      service.onModuleInit();

      const names = toolRegistry.registerAgentScopedTool.mock.calls.map((c) => c[0]);
      expect(names).toEqual(
        expect.arrayContaining([
          'create_scheduled_task',
          'write_daily_report',
          'list_scheduled_tasks',
          'delete_scheduled_task',
        ]),
      );
    });
  });

  describe('onApplicationBootstrap', () => {
    it('应恢复全部活跃任务到调度器', async () => {
      taskRepo.find.mockResolvedValue([{ ...baseTask }, { ...baseTask, id: 'task-2' }]);

      await service.onApplicationBootstrap();

      expect(taskRepo.find).toHaveBeenCalledWith({ where: { isActive: true } });
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(2);
    });
  });

  describe('runTask', () => {
    it('任务不存在或已停用应直接跳过', async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await service.runTask('task-x');
      expect(agentExecutor.runBatch).not.toHaveBeenCalled();

      taskRepo.findOne.mockResolvedValue({ ...baseTask, isActive: false });
      await service.runTask('task-1');
      expect(agentExecutor.runBatch).not.toHaveBeenCalled();
    });

    it('Agent 已停用应跳过执行', async () => {
      taskRepo.findOne.mockResolvedValue({ ...baseTask });
      agentRepo.findOne.mockResolvedValue({ ...agentConfig, isActive: false } as AgentConfig);

      await service.runTask('task-1');

      expect(agentExecutor.runBatch).not.toHaveBeenCalled();
    });

    it('成功路径：建会话 → 写触发消息 → runBatch → 落消息 → 归档 → 更新 lastRunAt', async () => {
      taskRepo.findOne.mockResolvedValue({ ...baseTask });
      agentRepo.findOne.mockResolvedValue(agentConfig);
      agentExecutor.runBatch.mockResolvedValue([
        { role: MessageRole.ASSISTANT, content: '日报已保存', toolCalls: null, totalTokens: 100 },
      ]);

      await service.runTask('task-1');

      // 会话标题带 [Auto] 前缀
      const convCreated = conversationRepo.create.mock.calls[0][0] as Conversation;
      expect(convCreated.title).toMatch(/^\[Auto\] /);
      expect(convCreated.agentConfigId).toBe('agent-1');

      // 触发消息以 user 角色落库
      const userMsg = messageRepo.create.mock.calls[0][0] as Message;
      expect(userMsg.role).toBe(MessageRole.USER);
      expect(userMsg.content).toContain('生成 AI 日报');

      // runBatch 走 conversationId 作为 threadId
      expect(agentExecutor.runBatch).toHaveBeenCalledWith(
        agentConfig,
        expect.stringContaining('生成 AI 日报'),
        { threadId: 'conv-1' },
      );

      // 执行结果消息落库 + 会话归档 + lastRunAt 更新
      expect(messageRepo.save).toHaveBeenCalledTimes(2);
      expect(conversationRepo.update).toHaveBeenCalledWith('conv-1', {
        status: ConversationStatus.ARCHIVED,
      });
      expect(taskRepo.update).toHaveBeenCalledWith('task-1', { lastRunAt: expect.any(Date) });
    });

    it('执行抛错应捕获并归档会话，不向外抛', async () => {
      taskRepo.findOne.mockResolvedValue({ ...baseTask });
      agentRepo.findOne.mockResolvedValue(agentConfig);
      agentExecutor.runBatch.mockRejectedValue(new Error('模型超时'));

      await expect(service.runTask('task-1')).resolves.toBeUndefined();

      expect(conversationRepo.update).toHaveBeenCalledWith('conv-1', {
        status: ConversationStatus.ARCHIVED,
      });
      expect(taskRepo.update).not.toHaveBeenCalled();
    });
  });
});
