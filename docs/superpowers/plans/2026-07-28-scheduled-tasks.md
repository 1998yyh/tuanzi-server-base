# Agent 定时任务与自动日报生成 Implementation Plan（第三期）

> **For agentic workers:** REQUIRED SUB-SKILL: Use tuanzii:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对话式创建 cron 定时任务，到点自动触发 Agent 走完整 tool loop（搜索 → 整理 → 调 `write_daily_report` 写库），前端零改动展示自动生成的日报。

**Architecture:** 新增 `ScheduledTask` 实体（表 `agent_scheduled_tasks`）+ `ScheduledTasksService`（校验/cron 注册/启动恢复/触发执行/写日报）。4 个对话工具以「Agent 作用域工具」形式注册进 `ToolRegistryService`（工厂按 `agentConfigId` 动态创建闭包，避免 registry → service 的循环依赖）。触发执行复用第二期 `AgentExecutorService.runBatch(threadId)`，新建 Conversation 承载执行记录，结束后自动归档。

**Tech Stack:** NestJS 11 + `@nestjs/schedule` 6（SchedulerRegistry + CronJob）+ `cron-parser` 5（校验与下次执行时间计算）+ TypeORM 0.3。

**前置依赖：** 第一期（MCP 工具库，搜索工具可关联到 Agent）、第二期（`runBatch`、`tool-names.ts` 的 `AGENT_SCOPED_TOOL_NAMES` 常量位）均已完成。

**源设计文档:** `docs/plans/2026-07-28-agents-scheduled-tasks-design.md`

## Global Constraints

- 错误消息与 API 文案一律中文。
- 实体：`snake_case` 表名/列名，uuid 主键，必填 `createdAt/updatedAt`。
- Service：找不到抛 `NotFoundException`；冲突抛 `ConflictException`；参数非法抛 `BadRequestException`（工具调用参数不走 HTTP 管道，在 service 入口手动校验）。
- 测试：放 `test/` 镜像 `src/` 结构，`src/` 别名导入，mock 全部外部依赖，测试描述用中文。
- 提交：conventional commits。
- 时区：cron 调度与「今天」日期一律按 `Asia/Shanghai`。
- 开发环境 `synchronize` 自动建表，不写 migration。
- 每个任务完成后跑 `pnpm typecheck` 与 `pnpm lint`。

## 文件清单

**新建：**
- `src/agents/scheduled-tasks/scheduled-task.entity.ts`
- `src/agents/scheduled-tasks/scheduled-tasks.service.ts`
- `test/agents/scheduled-tasks.service.spec.ts`

**修改：**
- `package.json` — 新增依赖 `@nestjs/schedule`、`cron-parser`
- `src/daily-reports/daily-reports.service.ts` — 新增 `upsert`
- `test/daily-reports/daily-reports.service.spec.ts` — 追加 upsert 用例
- `src/agents/tools/tool-names.ts` — `AGENT_SCOPED_TOOL_NAMES` 填入 4 个工具名
- `src/agents/tools/tool-registry.service.ts` — 新增 Agent 作用域工具注册机制
- `test/agents/tools/tool-registry.service.spec.ts` — 追加机制用例
- `src/agents/agents.module.ts` — `ScheduleModule.forRoot()` + `DailyReportsModule` + `ScheduledTask` 实体 + `ScheduledTasksService`

---

### Task 1: 安装依赖 + DailyReportsService.upsert

**Files:**
- Modify: `package.json`（`pnpm add`）
- Modify: `src/daily-reports/daily-reports.service.ts`
- Test: `test/daily-reports/daily-reports.service.spec.ts`

**Interfaces:**
- Consumes: 现有 `DailyReportsService.findByTypeAndDate(type, date)`。
- Produces: `DailyReportsService.upsert(dto: CreateDailyReportDto): Promise<DailyReport>` — 同 `type+date` 已存在则覆盖 title/content，否则新建（Task 3 的 `writeDailyReport` 依赖）。

- [ ] **Step 1: 安装依赖**

```bash
pnpm add @nestjs/schedule cron-parser
```

说明：`cron-parser` v5 自带类型定义（`dist/types/index.d.ts`），**不要**安装 `@types/cron-parser`（与设计文档第十节的有意偏差）。安装后确认 `package.json` 出现这两个包。

- [ ] **Step 2: 写失败测试**

在 `test/daily-reports/daily-reports.service.spec.ts` 的 `describe('remove')` 之后追加：

```typescript
  describe('upsert', () => {
    const upsertDto = {
      type: DailyReportType.AI,
      title: 'AI情报早报 | 2026-03-16',
      date: '2026-03-16',
      content: '# 新内容',
    };

    it('同类型同日期已存在时应该覆盖 title/content', async () => {
      repository.findOne.mockResolvedValue({ ...mockReport });
      repository.save.mockImplementation(async (v) => v as DailyReport);

      const result = await service.upsert(upsertDto);

      expect(repository.create).not.toHaveBeenCalled();
      const saved = repository.save.mock.calls[0][0] as DailyReport;
      expect(saved.id).toBe('test-uuid');
      expect(saved.content).toBe('# 新内容');
      expect(result.id).toBe('test-uuid');
    });

    it('不存在时应该新建', async () => {
      repository.findOne.mockResolvedValue(null);
      repository.create.mockReturnValue(mockReport);
      repository.save.mockResolvedValue(mockReport);

      const result = await service.upsert(upsertDto);

      expect(repository.create).toHaveBeenCalledWith(upsertDto);
      expect(result).toEqual(mockReport);
    });
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test -- daily-reports.service`
Expected: FAIL（`service.upsert is not a function`）

- [ ] **Step 4: 实现**

在 `src/daily-reports/daily-reports.service.ts` 的 `update` 方法后追加：

```typescript
  /** 同 type+date 已存在则覆盖 title/content，否则新建（AI 自动生成日报场景） */
  async upsert(dto: CreateDailyReportDto): Promise<DailyReport> {
    const existing = await this.findByTypeAndDate(dto.type, dto.date);
    if (existing) {
      existing.title = dto.title;
      existing.content = dto.content;
      return this.dailyReportRepository.save(existing);
    }
    return this.dailyReportRepository.save(this.dailyReportRepository.create(dto));
  }
```

- [ ] **Step 5: 跑测试确认通过 + commit**

```bash
pnpm test -- daily-reports.service
pnpm typecheck && pnpm lint
git add package.json pnpm-lock.yaml src/daily-reports test/daily-reports
git commit -m "feat(daily-reports): 新增 upsert 方法并安装定时任务依赖"
```

---

### Task 2: ToolRegistry Agent 作用域工具机制 + tool-names 填充

**Files:**
- Modify: `src/agents/tools/tool-names.ts`
- Modify: `src/agents/tools/tool-registry.service.ts`
- Test: `test/agents/tools/tool-registry.service.spec.ts`

**Interfaces:**
- Consumes: 第二期 `tool-names.ts` 的 `AGENT_SCOPED_TOOL_NAMES` 占位。
- Produces:
  - `AGENT_SCOPED_TOOL_NAMES = ['create_scheduled_task', 'write_daily_report', 'list_scheduled_tasks', 'delete_scheduled_task']`
  - `ToolRegistryService.registerAgentScopedTool(name: string, factory: (agentConfigId: string) => StructuredToolInterface): void`（Task 3 的 `ScheduledTasksService.onModuleInit` 调用）
  - `getToolsForAgent` 查找顺序：无状态内置工具 → Agent 作用域工厂 → 告警跳过；`listBuiltinToolNames()` 包含两类。

- [ ] **Step 1: 写失败测试**

在 `test/agents/tools/tool-registry.service.spec.ts` 的 `describe('内置工具')` 内追加：

```typescript
    it('registerAgentScopedTool 注册的工具应该按 agentConfigId 动态创建', async () => {
      const scopedTool = { name: 'list_scheduled_tasks', invoke: jest.fn() };
      const factory = jest.fn().mockReturnValue(scopedTool);
      service.registerAgentScopedTool('list_scheduled_tasks', factory);

      const tools = await service.getToolsForAgent(
        buildAgent({ enabledTools: ['list_scheduled_tasks'] }),
      );

      expect(factory).toHaveBeenCalledWith('agent-1');
      expect(tools).toEqual([scopedTool]);
    });

    it('listBuiltinToolNames 应该包含 Agent 作用域工具名', () => {
      service.registerAgentScopedTool('write_daily_report', () => ({}) as never);

      expect(service.listBuiltinToolNames()).toEqual(
        expect.arrayContaining(['web_search', 'calculator', 'write_daily_report']),
      );
    });

    it('未注册的工具名应该跳过并警告，不影响其他工具', async () => {
      const tools = await service.getToolsForAgent(
        buildAgent({ enabledTools: ['calculator', 'nonexistent'] }),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('calculator');
    });
```

（最后一例原 spec 已有，如重复可跳过。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- tool-registry.service`
Expected: FAIL（`registerAgentScopedTool is not a function`）

- [ ] **Step 3: 实现**

**3a. 修改 `src/agents/tools/tool-names.ts`：**

```typescript
/** Agent 作用域内置工具（按 agentConfigId 动态创建；第三期定时任务工具在此注册） */
export const AGENT_SCOPED_TOOL_NAMES: readonly string[] = [
  'create_scheduled_task',
  'write_daily_report',
  'list_scheduled_tasks',
  'delete_scheduled_task',
];
```

**3b. 修改 `src/agents/tools/tool-registry.service.ts`：**

- 类字段区追加：
```typescript
  /** Agent 作用域工具工厂：按 agentConfigId 动态创建工具实例（如定时任务工具） */
  private readonly agentScopedToolFactories = new Map<
    string,
    (agentConfigId: string) => StructuredToolInterface
  >();
```
- `listBuiltinToolNames` 改为：
```typescript
  /** 返回全部内置工具名（含 Agent 作用域工具），供前端展示可选列表 */
  listBuiltinToolNames(): string[] {
    return [...this.builtinTools.keys(), ...this.agentScopedToolFactories.keys()];
  }

  /**
   * 注册 Agent 作用域工具：工具 func 需要知道当前 Agent 身份（如定时任务归属），
   * 故以工厂形式注册，getToolsForAgent 时按 config.id 创建实例。
   * 由 ScheduledTasksService.onModuleInit 调用（反向注入会破坏模块依赖方向）。
   */
  registerAgentScopedTool(
    name: string,
    factory: (agentConfigId: string) => StructuredToolInterface,
  ): void {
    this.agentScopedToolFactories.set(name, factory);
  }
```
- `getToolsForAgent` 中 enabledTools 循环改为：
```typescript
    for (const name of config.enabledTools ?? []) {
      const tool = this.builtinTools.get(name);
      if (tool) {
        tools.push(tool);
        continue;
      }
      const factory = this.agentScopedToolFactories.get(name);
      if (factory) {
        tools.push(factory(config.id));
        continue;
      }
      this.logger.warn(`Agent "${config.name}" 启用了不存在的内置工具: ${name}`);
    }
```

- [ ] **Step 4: 跑测试确认通过 + commit**

```bash
pnpm test -- tool-registry.service
pnpm typecheck && pnpm lint
git add src/agents/tools test/agents/tools
git commit -m "feat(agents): ToolRegistry 支持 Agent 作用域工具注册机制"
```

---

### Task 3: ScheduledTask 实体 + ScheduledTasksService + 4 个工具 + 模块接线

**Files:**
- Create: `src/agents/scheduled-tasks/scheduled-task.entity.ts`
- Create: `src/agents/scheduled-tasks/scheduled-tasks.service.ts`
- Modify: `src/agents/agents.module.ts`
- Test: `test/agents/scheduled-tasks.service.spec.ts`

**Interfaces:**
- Consumes:
  - `DailyReportsService.upsert`（Task 1）
  - `ToolRegistryService.registerAgentScopedTool`（Task 2）
  - `AgentExecutorService.runBatch(agentConfig, userMessage, { threadId })`（第二期）
  - `DailyReportType`（`src/daily-reports/daily-reports.entity.ts`）
  - `Conversation`/`ConversationStatus`、`Message`/`MessageRole`（`src/agents/entities/`）
- Produces:
  - `ScheduledTask` 实体（表 `agent_scheduled_tasks`）
  - `ScheduledTasksService`：
    - `createTask(agentConfigId: string, params: { cronExpression: string; reportType: string; description: string }): Promise<{ success: true; taskId: string; nextRunAt: string }>`
    - `listTasks(agentConfigId: string): Promise<{ tasks: ScheduledTask[] }>`
    - `deleteTask(agentConfigId: string, taskId: string): Promise<{ success: true }>`
    - `writeDailyReport(params: { type: string; title: string; content: string; date?: string }): Promise<{ success: true; id: string }>`
    - `runTask(taskId: string): Promise<void>`
    - `onApplicationBootstrap()`（恢复活跃任务）、`onModuleInit()`（注册 4 个工具）

- [ ] **Step 1: 写失败测试**

创建 `test/agents/scheduled-tasks.service.spec.ts`：

```typescript
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
jest.mock('@nestjs/schedule', () => {
  const actual = jest.requireActual('@nestjs/schedule');
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- scheduled-tasks.service`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

**3a. 创建 `src/agents/scheduled-tasks/scheduled-task.entity.ts`：**

```typescript
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { AgentConfig } from '../entities/agent-config.entity';
import { DailyReportType } from '../../daily-reports/daily-reports.entity';

/**
 * Agent 定时任务：按 cron 表达式触发 Agent 自动执行（如每日生成日报）。
 * 同一 agentConfigId + reportType 下最多 1 个活跃任务（代码层校验，见 ScheduledTasksService）。
 */
@Entity('agent_scheduled_tasks')
@Index(['agentConfigId', 'isActive'])
export class ScheduledTask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => AgentConfig, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_config_id' })
  agentConfig: AgentConfig;

  @Column({ name: 'agent_config_id' })
  agentConfigId: string;

  @Column({ name: 'report_type', type: 'enum', enum: DailyReportType })
  reportType: DailyReportType;

  /** cron 表达式（如 "0 8 * * *"），按 Asia/Shanghai 时区调度 */
  @Column({ name: 'cron_expression', length: 100 })
  cronExpression: string;

  /** 任务描述：定时触发时拼接为 Agent 的执行指令 */
  @Column({ length: 255 })
  description: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'last_run_at', type: 'datetime', nullable: true })
  lastRunAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

**3b. 创建 `src/agents/scheduled-tasks/scheduled-tasks.service.ts`：**

```typescript
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { CronJob, SchedulerRegistry } from '@nestjs/schedule';
import { CronExpressionParser } from 'cron-parser';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ScheduledTask } from './scheduled-task.entity';
import { AgentConfig } from '../entities/agent-config.entity';
import { Conversation, ConversationStatus } from '../entities/conversation.entity';
import { Message, MessageRole } from '../entities/message.entity';
import { AgentExecutorService } from '../agent-executor.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { DailyReportsService } from '../../daily-reports/daily-reports.service';
import { DailyReportType } from '../../daily-reports/daily-reports.entity';

/** 调度与「今天」日期统一按上海时区 */
const TZ = 'Asia/Shanghai';
/** 定时任务最小间隔（防止高频任务打爆 LLM 调用） */
const MIN_INTERVAL_MS = 60 * 60 * 1000;
/** 日报正文长度上限 64KB */
const MAX_CONTENT_LENGTH = 64 * 1024;

const REPORT_TYPE_LABEL: Record<DailyReportType, string> = {
  [DailyReportType.AI]: 'AI 日报',
  [DailyReportType.STOCK]: '股票日报',
};

/**
 * 定时任务管理：对话式创建/查询/删除 + cron 调度 + 触发执行 + 日报写入。
 *
 * - 4 个对话工具在 onModuleInit 注册到 ToolRegistryService（Agent 作用域工具）
 * - 应用重启后 onApplicationBootstrap 恢复全部活跃任务；停机期间错过的触发不补跑
 * - 触发执行复用 AgentExecutorService.runBatch，会话执行完自动归档
 */
@Injectable()
export class ScheduledTasksService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledTasksService.name);

  constructor(
    @InjectRepository(ScheduledTask)
    private readonly taskRepo: Repository<ScheduledTask>,
    @InjectRepository(AgentConfig)
    private readonly agentRepo: Repository<AgentConfig>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly agentExecutor: AgentExecutorService,
    private readonly dailyReportsService: DailyReportsService,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  /** 注册 4 个 Agent 作用域工具（func 闭包捕获 agentConfigId） */
  onModuleInit() {
    this.toolRegistry.registerAgentScopedTool(
      'create_scheduled_task',
      (agentConfigId) =>
        new DynamicStructuredTool({
          name: 'create_scheduled_task',
          description:
            '创建定时任务：按 cron 表达式周期触发本 Agent 自动执行指定工作（如每日生成日报）。同类型日报只能有一个活跃任务。',
          schema: z.object({
            cronExpression: z
              .string()
              .describe('cron 表达式，如 "0 8 * * *" 表示每天早 8 点（Asia/Shanghai），间隔不得小于 1 小时'),
            reportType: z.enum(['ai', 'stock']).describe('日报类型'),
            description: z.string().describe('任务描述，定时触发时会作为执行指令交给 Agent'),
          }),
          func: async (args) => this.createTask(agentConfigId, args),
        }),
    );

    this.toolRegistry.registerAgentScopedTool(
      'write_daily_report',
      () =>
        new DynamicStructuredTool({
          name: 'write_daily_report',
          description:
            '把整理好的日报内容写入数据库（Markdown 格式）。同类型同日期的内容会覆盖旧记录。',
          schema: z.object({
            type: z.enum(['ai', 'stock']).describe('日报类型'),
            title: z.string().describe('日报标题'),
            content: z.string().describe('日报正文（Markdown）'),
            date: z.string().optional().describe('日期 YYYY-MM-DD，缺省为今天'),
          }),
          func: async (args) => this.writeDailyReport(args),
        }),
    );

    this.toolRegistry.registerAgentScopedTool(
      'list_scheduled_tasks',
      (agentConfigId) =>
        new DynamicStructuredTool({
          name: 'list_scheduled_tasks',
          description: '列出本 Agent 的全部定时任务（含已停用的历史任务）。',
          schema: z.object({}),
          func: async () => this.listTasks(agentConfigId),
        }),
    );

    this.toolRegistry.registerAgentScopedTool(
      'delete_scheduled_task',
      (agentConfigId) =>
        new DynamicStructuredTool({
          name: 'delete_scheduled_task',
          description: '删除本 Agent 的指定定时任务。',
          schema: z.object({
            taskId: z.string().uuid().describe('任务 ID（从 list_scheduled_tasks 获取）'),
          }),
          func: async (args) => this.deleteTask(agentConfigId, args.taskId),
        }),
    );
  }

  /** 应用重启后恢复全部活跃任务；停机期间错过的触发不补跑（避免启动雪崩） */
  async onApplicationBootstrap() {
    const activeTasks = await this.taskRepo.find({ where: { isActive: true } });
    for (const task of activeTasks) {
      this.registerCronJob(task);
    }
    this.logger.log(`已恢复 ${activeTasks.length} 个定时任务`);
  }

  async createTask(
    agentConfigId: string,
    params: { cronExpression: string; reportType: string; description: string },
  ): Promise<{ success: true; taskId: string; nextRunAt: string }> {
    this.assertValidCron(params.cronExpression);
    const reportType = this.assertReportType(params.reportType);    if (!params.description?.trim()) {
      throw new BadRequestException('描述不能为空');
    }
    if (params.description.length > 255) {
      throw new BadRequestException('描述最长 255 字符');
    }

    const existing = await this.taskRepo.findOne({
      where: { agentConfigId, reportType, isActive: true },
    });
    if (existing) {
      throw new ConflictException(
        `该 Agent 已有 ${REPORT_TYPE_LABEL[reportType]}定时任务，请先删除旧任务`,
      );
    }

    const task = await this.taskRepo.save(
      this.taskRepo.create({
        agentConfigId,
        reportType,
        cronExpression: params.cronExpression,
        description: params.description.trim(),
        isActive: true,
        lastRunAt: null,
      }),
    );
    this.registerCronJob(task);

    // 用全新的解析实例计算下次执行时间（assertValidCron 内的迭代器已消费过）
    const nextRunAt = CronExpressionParser.parse(params.cronExpression, { tz: TZ })
      .next()
      .toDate()
      .toISOString();
    return { success: true, taskId: task.id, nextRunAt };
  }

  async listTasks(agentConfigId: string): Promise<{ tasks: ScheduledTask[] }> {
    const tasks = await this.taskRepo.find({
      where: { agentConfigId },
      order: { createdAt: 'DESC' },
    });
    return { tasks };
  }

  async deleteTask(agentConfigId: string, taskId: string): Promise<{ success: true }> {
    const task = await this.taskRepo.findOne({ where: { id: taskId, agentConfigId } });
    if (!task) {
      throw new BadRequestException('任务不存在或无权限删除');
    }
    if (this.schedulerRegistry.doesExist('cron', task.id)) {
      this.schedulerRegistry.deleteCronJob(task.id);
    }
    await this.taskRepo.remove(task);
    return { success: true };
  }

  /** write_daily_report 工具入口：手动校验后走 upsert（同类型同日期覆盖） */
  async writeDailyReport(params: {
    type: string;
    title: string;
    content: string;
    date?: string;
  }): Promise<{ success: true; id: string }> {
    const type = this.assertReportType(params.type);
    if (!params.title?.trim()) {
      throw new BadRequestException('标题不能为空');
    }
    if (params.title.length > 255) {
      throw new BadRequestException('标题最长 255 字符');
    }
    if (!params.content?.trim()) {
      throw new BadRequestException('内容不能为空');
    }
    if (params.content.length > MAX_CONTENT_LENGTH) {
      throw new BadRequestException('内容过长（最大 64KB）');
    }
    const date = params.date ?? this.todayInShanghai();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) {
      throw new BadRequestException('日期格式错误，应为 YYYY-MM-DD');
    }

    const report = await this.dailyReportsService.upsert({
      type,
      title: params.title.trim(),
      content: params.content,
      date,
    });
    return { success: true, id: report.id };
  }

  /**
   * cron 触发执行：新建会话 → 写触发消息 → runBatch 走完整 tool loop →
   * 落执行消息 → 归档会话 → 更新 lastRunAt。
   * 任何异常只记录日志（会话照常归档），不影响下次调度。
   */
  async runTask(taskId: string): Promise<void> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task || !task.isActive) return;

    const agentConfig = await this.agentRepo.findOne({ where: { id: task.agentConfigId } });
    if (!agentConfig || !agentConfig.isActive) {
      this.logger.warn(`定时任务 ${taskId} 的 Agent 不存在或已停用，跳过执行`);
      return;
    }

    const today = this.todayInShanghai();
    const conversation = await this.conversationRepo.save(
      this.conversationRepo.create({
        agentConfigId: agentConfig.id,
        title: `[Auto] ${REPORT_TYPE_LABEL[task.reportType]} ${today}`,
        status: ConversationStatus.ACTIVE,
      }),
    );

    try {
      const triggerMessage =
        `今天是 ${today}。请完成以下工作：${task.description}。` +
        `完成后务必调用 write_daily_report 工具，把结果保存为 ${task.reportType} 类型、日期为 ${today} 的日报。`;
      await this.messageRepo.save(
        this.messageRepo.create({
          conversationId: conversation.id,
          role: MessageRole.USER,
          content: triggerMessage,
        }),
      );

      const newMessages = await this.agentExecutor.runBatch(agentConfig, triggerMessage, {
        threadId: conversation.id,
      });
      if (newMessages.length) {
        await this.messageRepo.save(
          newMessages.map((m) => this.messageRepo.create({ conversationId: conversation.id, ...m })),
        );
      }
      await this.taskRepo.update(taskId, { lastRunAt: new Date() });
      this.logger.log(`定时任务 ${taskId}（${REPORT_TYPE_LABEL[task.reportType]}）执行完成`);
    } catch (e) {
      this.logger.error(`定时任务 ${taskId} 执行失败: ${(e as Error).message}`);
    } finally {
      // 定时任务产生的会话自动归档，不干扰用户主动创建的会话列表
      await this.conversationRepo.update(conversation.id, {
        status: ConversationStatus.ARCHIVED,
      });
    }
  }

  /** 注册/重注册 cron job 到调度器（重复注册同名先删后加） */
  private registerCronJob(task: ScheduledTask): void {
    if (this.schedulerRegistry.doesExist('cron', task.id)) {
      this.schedulerRegistry.deleteCronJob(task.id);
    }
    const job = new CronJob(
      task.cronExpression,
      () => {
        void this.runTask(task.id);
      },
      null,
      true,
      TZ,
    );
    this.schedulerRegistry.addCronJob(task.id, job);
  }

  /** 校验 cron 表达式；间隔 < 1 小时的表达式拒绝 */
  private assertValidCron(expression: string): void {
    let cron;
    try {
      cron = CronExpressionParser.parse(expression, { tz: TZ });
    } catch {
      throw new BadRequestException('不合法的 cron 表达式');
    }
    const first = cron.next().toDate().getTime();
    const second = cron.next().toDate().getTime();
    if (second - first < MIN_INTERVAL_MS) {
      throw new BadRequestException('任务间隔不能少于 1 小时');
    }
  }

  private assertReportType(type: string): DailyReportType {
    if (type !== DailyReportType.AI && type !== DailyReportType.STOCK) {
      throw new BadRequestException('日报类型必须是 ai 或 stock');
    }
    return type;
  }

  /** Asia/Shanghai 时区的今天，格式 YYYY-MM-DD（en-CA locale 输出即该格式） */
  private todayInShanghai(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  }
}
```

**3c. 修改 `src/agents/agents.module.ts`：**

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AgentConfig } from './entities/agent-config.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { AgentCheckpoint } from './entities/agent-checkpoint.entity';
import { AgentCheckpointWrite } from './entities/agent-checkpoint-write.entity';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { AgentExecutorService } from './agent-executor.service';
import { ToolRegistryService } from './tools/tool-registry.service';
import { TypeORMCheckpointer } from './checkpointers/typeorm.checkpointer';
import { encryptionKeyProvider } from './utils/encryption-key.provider';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { SkillsModule } from '../skills/skills.module';
import { DailyReportsModule } from '../daily-reports/daily-reports.module';
import { ScheduledTask } from './scheduled-tasks/scheduled-task.entity';
import { ScheduledTasksService } from './scheduled-tasks/scheduled-tasks.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      AgentConfig,
      Conversation,
      Message,
      AgentCheckpoint,
      AgentCheckpointWrite,
      ScheduledTask,
    ]),
    McpServersModule,
    SkillsModule,
    DailyReportsModule,
  ],
  controllers: [AgentsController, ConversationsController],
  providers: [
    AgentsService,
    ConversationsService,
    AgentExecutorService,
    ToolRegistryService,
    TypeORMCheckpointer,
    ScheduledTasksService,
    encryptionKeyProvider,
  ],
})
export class AgentsModule {}
```

（`McpServersModule`/`SkillsModule` 在第一、二期已加入，此处全量展示便于核对最终形态。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- scheduled-tasks.service`
Expected: PASS

- [ ] **Step 5: typecheck + lint + 全量回归 + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/agents test/agents
git commit -m "feat(agents): 新增定时任务调度与对话式任务管理工具"
```

- [ ] **Step 6: 重启 dev server 验证**

```bash
pnpm start:dev
```

- 用 Adminer（http://localhost:8080）确认 `agent_scheduled_tasks` 表已建（含 `idx` 复合索引）。
- 启动日志应出现 `已恢复 0 个定时任务`。
- （可选端到端）通过对话让 Agent 调用 `create_scheduled_task` 创建一个任务，再到 Adminer 确认落库。
确认后停掉 dev server。

---

## 自审记录

- **Spec coverage**：实体（Task 3）、4 个工具（Task 3 `onModuleInit`）、cron 校验规则（`assertValidCron`/`assertReportType`/标题/内容/日期校验）、唯一性约束（`createTask` 409）、执行流程（`runTask` 全链路）、启动恢复（`onApplicationBootstrap`，不补跑）、`runBatch` 复用（第二期已实现）、`upsert`（Task 1）、时区（`Asia/Shanghai` 统一）。
- **已知偏差（有意）**：
  1. 不安装 `@types/cron-parser`——cron-parser v5 自带类型。
  2. 4 个工具未硬编码进 `ToolRegistryService.onModuleInit`，而是经 `registerAgentScopedTool` 由 `ScheduledTasksService` 注册——工具的 func 需要 agentConfigId 闭包，且可避免 registry → service 循环依赖；对 `enabledTools` 与 `listBuiltinToolNames` 的行为与设计一致。
  3. `write_daily_report` 的校验放在 `ScheduledTasksService.writeDailyReport`（设计第七节的「校验实现位置」即 ScheduledTasksService 方法入口）。
