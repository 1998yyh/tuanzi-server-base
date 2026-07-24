import { DynamicStructuredTool } from '@langchain/core/tools';

/**
 * 内置工具统一基类。
 *
 * 每个内置工具是一个 DynamicStructuredTool 子类，在构造器里通过 super({...})
 * 声明 name / description / schema / func，ToolRegistryService 按 name 注册与查找。
 * 工具执行失败时不向外抛异常，而是返回错误文案作为工具结果，交给 LLM 决策
 * （见 AgentExecutorService 的 tools_node）。
 *
 * 新增内置工具：tools/builtin/ 下新建文件继承本类，然后在
 * ToolRegistryService.onModuleInit() 中注册。
 */
export abstract class BaseBuiltinTool extends DynamicStructuredTool {}
