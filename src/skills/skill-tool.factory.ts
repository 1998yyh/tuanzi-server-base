import { Injectable, Logger } from '@nestjs/common';
import { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import { AgentConfig } from '../agents/entities/agent-config.entity';
import { BatchRunOptions } from '../agents/agent-executor.service';
import { NewMessageData } from '../agents/agents.types';
import { MessageRole } from '../agents/entities/message.entity';
import { ALL_BUILTIN_TOOL_NAMES } from '../agents/tools/tool-names';
import { Skill } from './skill.entity';
import { SkillsService } from './skills.service';
import { buildSkillInputSchema } from './skill-input-schema.util';

/**
 * Skill 执行所需的回调，由 AgentExecutorService 传入（反向注入会破坏模块依赖方向）：
 * - runBatch：借用主 Agent 的 provider/model/apiKey 做一次性批量执行
 * - buildSubTools：按 Skill 的 enabledTools + mcpServers 构建子 Agent 工具集
 */
export interface SkillExecutionDeps {
  runBatch: (userMessage: string, options: BatchRunOptions) => Promise<NewMessageData[]>;
  buildSubTools: (skill: Skill) => Promise<StructuredToolInterface[]>;
}

/**
 * Skill → DynamicStructuredTool 转换工厂。
 *
 * 主 Agent 像调用普通工具一样调用 Skill；func 内部以 Skill 的 systemPrompt +
 * 工具集起一次性子 Agent（isSkillExecution=true，子 Agent 不再注入 Skill 工具，防递归），
 * 把子 Agent 最终输出作为工具结果返回给主 Agent。
 */
@Injectable()
export class SkillToolFactory {
  private readonly logger = new Logger(SkillToolFactory.name);

  constructor(private readonly skillsService: SkillsService) {}

  async createToolsForAgent(
    agentConfig: AgentConfig,
    deps: SkillExecutionDeps,
  ): Promise<DynamicStructuredTool[]> {
    const skills = await this.skillsService.findByAgentConfig(agentConfig.id);
    const tools: DynamicStructuredTool[] = [];

    for (const skill of skills) {
      // name 冲突检查：Skill 名进入主 Agent 工具列表，不能覆盖内置工具
      if (ALL_BUILTIN_TOOL_NAMES.includes(skill.name)) {
        this.logger.warn(`Skill "${skill.name}" 与内置工具同名，已跳过（请改名后重新关联）`);
        continue;
      }

      tools.push(
        new DynamicStructuredTool({
          name: skill.name,
          description: skill.description,
          schema: buildSkillInputSchema(skill.inputSchema),
          func: async (args) => {
            const input =
              typeof (args as { input?: unknown })?.input === 'string'
                ? (args as { input: string }).input
                : JSON.stringify(args ?? {});
            try {
              const subTools = await deps.buildSubTools(skill);
              const messages = await deps.runBatch(input, {
                overrideSystemPrompt: skill.systemPrompt,
                overrideTools: subTools,
                isSkillExecution: true,
              });
              const last = messages.findLast((m) => m.role === MessageRole.ASSISTANT);
              return last?.content || '（子 Agent 未产生输出）';
            } catch (e) {
              // 与内置工具一致：失败信息作为工具结果交给主 Agent 决策，不向外抛
              return `Skill 执行失败: ${(e as Error).message}`;
            }
          },
        }),
      );
    }

    return tools;
  }
}
