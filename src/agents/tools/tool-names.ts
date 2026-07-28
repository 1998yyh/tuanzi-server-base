/**
 * 内置工具名注册表（静态常量）。
 *
 * 存在意义：SkillsService 需要校验 Skill.enabledTools 是否合法，
 * 若注入 ToolRegistryService 会形成 AgentsModule ↔ SkillsModule 循环依赖，
 * 故工具名在此静态维护，ToolRegistryService 实例化时以此为唯一来源。
 */

/** 无状态内置工具（ToolRegistryService.onModuleInit 实例化） */
export const BUILTIN_TOOL_NAMES = ['web_search', 'calculator'] as const;

/** Agent 作用域内置工具（按 agentConfigId 动态创建；第三期定时任务工具在此注册） */
export const AGENT_SCOPED_TOOL_NAMES: readonly string[] = [
  'create_scheduled_task',
  'write_daily_report',
  'list_scheduled_tasks',
  'delete_scheduled_task',
];

/** 全部可启用的内置工具名（Skill.enabledTools 等校验用） */
export const ALL_BUILTIN_TOOL_NAMES: readonly string[] = [
  ...BUILTIN_TOOL_NAMES,
  ...AGENT_SCOPED_TOOL_NAMES,
];
