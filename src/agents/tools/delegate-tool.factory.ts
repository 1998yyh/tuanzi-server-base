import { Injectable } from '@nestjs/common';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

/** 子代理执行最长时长（分钟级任务，覆盖 invokeToolWithTimeout 的默认 30s） */
const DELEGATE_TIMEOUT_MS = 10 * 60_000;

/**
 * delegate_task 执行所需的回调，由 AgentExecutorService 传入（反向注入会破坏
 * 模块依赖方向，模式与 SkillToolFactory 一致）：
 * runSubAgent 起一次性子代理运行并返回其最终 assistant 文本；运行中的内部事件
 * （思考/工具调用）由 executor 经 subHook 实时包装为 sub_event 透出。
 */
export interface DelegateExecutionDeps {
  runSubAgent: (task: string, callId: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * delegate_task 工具工厂：把独立子任务委派给继承父 Agent 配置的子代理。
 *
 * 与 Skill 子代理的区别：Skill 是预设指令的命名工具，delegate_task 是通用委派——
 * 任务描述由主 Agent 现场编写。子代理不再注入 Skill/delegate 工具（深度锁死为 1，
 * 见 AgentExecutorService.getAllTools）。
 *
 * 仅流式路径（runStream）注入：批量路径没有事件透出能力，子代理会静默长跑。
 */
@Injectable()
export class DelegateToolFactory {
  createTool(deps: DelegateExecutionDeps): DynamicStructuredTool {
    const tool = new DynamicStructuredTool({
      name: 'delegate_task',
      description:
        '把独立的子任务委派给一个子代理执行。子代理继承当前 Agent 的内置/MCP 工具' +
        '（不含 Skill，也不能再委派），完成后返回结论。适合需要多步工具调用才能完成的' +
        '独立子任务。任务描述必须完整自包含——子代理看不到当前对话上下文。',
      schema: z.object({
        task: z.string().describe('交给子代理的完整、自包含的任务描述'),
      }),
      func: async (args, _runManager, config) => {
        // 父工具调用 id（invokeToolWithTimeout 经 metadata 透传）：子代理事件按它归组
        const callId =
          (config?.metadata as { tool_call_id?: string } | undefined)?.tool_call_id ?? '';
        return deps.runSubAgent(args.task as string, callId, config?.signal);
      },
    });
    // 子代理执行是分钟级任务：覆盖默认 30s 工具超时（invokeToolWithTimeout 读此字段）
    (tool as unknown as { timeoutMs: number }).timeoutMs = DELEGATE_TIMEOUT_MS;
    return tool;
  }
}
