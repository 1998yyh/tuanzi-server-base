import { Test, TestingModule } from '@nestjs/testing';
import { StructuredToolInterface } from '@langchain/core/tools';
import { SkillToolFactory, SkillExecutionDeps } from 'src/skills/skill-tool.factory';
import { SkillsService } from 'src/skills/skills.service';
import { Skill } from 'src/skills/skill.entity';
import { AgentConfig } from 'src/agents/entities/agent-config.entity';
import { MessageRole } from 'src/agents/entities/message.entity';

describe('SkillToolFactory', () => {
  let factory: SkillToolFactory;
  let skillsService: Record<string, jest.Mock>;
  let deps: SkillExecutionDeps & { runBatch: jest.Mock; buildSubTools: jest.Mock };

  const agentConfig = {
    id: 'agent-1',
    name: '主 Agent',
    channelId: 'ch-1',
    modelName: 'claude-opus-4-8',
  } as AgentConfig;

  const buildSkill = (override: Partial<Skill> = {}): Skill =>
    ({
      id: 'skill-1',
      name: 'generate_ai_report',
      description: '生成 AI 日报',
      systemPrompt: '你是日报撰写助手',
      inputSchema: null,
      enabledTools: ['web_search'],
      isActive: true,
      mcpServers: [],
      ...override,
    }) as Skill;

  beforeEach(async () => {
    skillsService = { findByAgentConfig: jest.fn().mockResolvedValue([buildSkill()]) };
    deps = {
      runBatch: jest.fn(),
      buildSubTools: jest.fn().mockResolvedValue([]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [SkillToolFactory, { provide: SkillsService, useValue: skillsService }],
    }).compile();

    factory = module.get(SkillToolFactory);
  });

  it('应该为每个 Skill 生成同名 DynamicStructuredTool', async () => {
    const tools = await factory.createToolsForAgent(agentConfig, deps);

    expect(skillsService.findByAgentConfig).toHaveBeenCalledWith('agent-1');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('generate_ai_report');
    expect(tools[0].description).toBe('生成 AI 日报');
  });

  it('func 应该构建子工具并以覆盖配置调用 runBatch，返回最后的 assistant 输出', async () => {
    const subTool = { name: 'web_search' } as StructuredToolInterface;
    deps.buildSubTools.mockResolvedValue([subTool]);
    deps.runBatch.mockResolvedValue([
      { role: MessageRole.TOOL, content: '搜索结果' },
      { role: MessageRole.ASSISTANT, content: '日报已生成' },
    ]);

    const tools = await factory.createToolsForAgent(agentConfig, deps);
    const result = (await tools[0].invoke({ input: '生成本周 AI 日报' })) as string;

    expect(deps.buildSubTools).toHaveBeenCalledWith(expect.objectContaining({ id: 'skill-1' }));
    expect(deps.runBatch).toHaveBeenCalledWith('生成本周 AI 日报', {
      overrideSystemPrompt: '你是日报撰写助手',
      overrideTools: [subTool],
      isSkillExecution: true,
    });
    expect(result).toBe('日报已生成');
  });

  it('func 执行异常应该返回错误文案而不是抛出', async () => {
    deps.runBatch.mockRejectedValue(new Error('模型超时'));

    const tools = await factory.createToolsForAgent(agentConfig, deps);
    const result = (await tools[0].invoke({ input: '执行' })) as string;

    expect(result).toContain('Skill 执行失败');
    expect(result).toContain('模型超时');
  });

  it('与内置工具同名的 Skill 应该跳过并告警', async () => {
    skillsService.findByAgentConfig.mockResolvedValue([buildSkill({ name: 'web_search' })]);

    const tools = await factory.createToolsForAgent(agentConfig, deps);

    expect(tools).toHaveLength(0);
  });
});
