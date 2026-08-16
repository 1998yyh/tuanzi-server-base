/**
 * 内置工具名注册表（静态常量）。
 *
 * 存在意义：SkillsService 需要校验 Skill.enabledTools 是否合法，
 * 若注入 ToolRegistryService 会形成 AgentsModule ↔ SkillsModule 循环依赖，
 * 故工具名在此静态维护，ToolRegistryService 实例化时以此为唯一来源。
 */

/** 无状态内置工具（ToolRegistryService.onModuleInit 实例化） */
export const BUILTIN_TOOL_NAMES = ['web_search', 'calculator'] as const;

/** 画布工具名（CanvasToolsService 注册的 Agent 作用域工具） */
export const CANVAS_TOOL_NAMES: readonly string[] = [
  'canvas_list_projects',
  'canvas_get_state',
  'canvas_create_node',
  'canvas_create_text_node',
  'canvas_create_text_nodes',
  'canvas_create_config_node',
  'canvas_create_image_prompt_flow',
  'canvas_update_node',
  'canvas_update_node_text',
  'canvas_move_nodes',
  'canvas_resize_node',
  'canvas_delete_nodes',
  'canvas_connect_nodes',
  'canvas_apply_ops',
  'canvas_run_generation',
  'generation_get_status',
  'prompts_search',
  'assets_list',
  'assets_add',
];

/** Agent 作用域内置工具（按 agentConfigId 动态创建） */
export const AGENT_SCOPED_TOOL_NAMES: readonly string[] = [
  'create_scheduled_task',
  'write_daily_report',
  'list_scheduled_tasks',
  'delete_scheduled_task',
  'run_background_task',
  ...CANVAS_TOOL_NAMES,
];

/**
 * 执行器按运行注入的工具（registry 查不到，getToolsForAgent 应跳过不告警）：
 * delegate_task 需要 runStream 的 subHook 回调才能工作，由 AgentExecutorService
 * 在流式执行时注入。
 */
export const EXECUTOR_INJECTED_TOOL_NAMES: readonly string[] = ['delegate_task'];

/** 全部可启用的内置工具名（Skill.enabledTools 等校验用） */
export const ALL_BUILTIN_TOOL_NAMES: readonly string[] = [
  ...BUILTIN_TOOL_NAMES,
  ...AGENT_SCOPED_TOOL_NAMES,
  ...EXECUTOR_INJECTED_TOOL_NAMES,
];
