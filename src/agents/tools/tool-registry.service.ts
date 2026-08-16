import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { StructuredToolInterface } from '@langchain/core/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { AgentConfig } from '../entities/agent-config.entity';
import { McpServerRuntimeConfig, McpServerType } from '../../mcp-servers/mcp-server.entity';
import { EXECUTOR_INJECTED_TOOL_NAMES } from './tool-names';
import { WebSearchTool } from './builtin/web-search.tool';
import { CalculatorTool } from './builtin/calculator.tool';

/**
 * 工具注册表：内置工具 + MCP 客户端连接池管理。
 *
 * - 内置工具按 name 注册，AgentConfig.enabledTools 按需取用
 * - MCP Server 由调用方（AgentExecutorService）从 mcp_servers 表加载解密后传入，
 *   Client 以 transport+endpoint+env/headers（sha256 摘要）为 key 复用连接，
 *   并发同 key 单飞共享 connect，模块销毁时统一关闭
 * - 单个 MCP Server 连接失败不阻断整体——跳过该 Server 并记录警告
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly builtinTools = new Map<string, StructuredToolInterface>();
  /** Agent 作用域工具工厂：按 agentConfigId 动态创建工具实例（如定时任务工具） */
  private readonly agentScopedToolFactories = new Map<
    string,
    (agentConfigId: string) => StructuredToolInterface
  >();
  private readonly mcpClients = new Map<string, Client>();
  /** 单飞：同 cacheKey 的 connect 进行中缓存（Promise），成功后转入 mcpClients */
  private readonly pendingConnections = new Map<string, Promise<Client>>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.builtinTools.set('web_search', new WebSearchTool(this.config));
    this.builtinTools.set('calculator', new CalculatorTool());
    // 后续新增内置工具在此注册
  }

  async onModuleDestroy() {
    // 等进行中的连接收敛（失败路径内部已 close，成功路径会入池），再统一关闭已建立的连接
    const inFlight = [...this.pendingConnections.values()];
    this.pendingConnections.clear();
    for (const promise of inFlight) {
      await promise.catch(() => undefined);
    }
    for (const client of this.mcpClients.values()) {
      try {
        await client.close();
      } catch (e) {
        this.logger.warn(`关闭 MCP 连接失败: ${(e as Error).message}`);
      }
    }
    this.mcpClients.clear();
  }

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

  async getToolsForAgent(
    config: AgentConfig,
    mcpServers: McpServerRuntimeConfig[] = [],
  ): Promise<StructuredToolInterface[]> {
    const tools: StructuredToolInterface[] = [];

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
      // 执行器按运行注入的工具（delegate_task 等）registry 查不到，跳过不告警
      if (EXECUTOR_INJECTED_TOOL_NAMES.includes(name)) {
        continue;
      }
      this.logger.warn(`Agent "${config.name}" 启用了不存在的内置工具: ${name}`);
    }

    for (const server of mcpServers) {
      try {
        const mcpTools = await this.loadMcpTools(server);
        tools.push(...mcpTools);
      } catch (e) {
        // MCP 连接失败不阻断整体——跳过该 Server，日志记录警告
        this.logger.warn(`MCP Server "${server.name}" 连接失败，已跳过: ${(e as Error).message}`);
      }
    }

    return tools;
  }

  private async loadMcpTools(server: McpServerRuntimeConfig): Promise<StructuredToolInterface[]> {
    const client = await this.connectOrGet(server);
    // 必须用 @langchain/mcp-adapters 的 loadMcpTools 做 JSON Schema → Zod 转换：
    // MCP 返回的 inputSchema 是 JSON Schema 对象，直接强转 ZodSchema 会在运行时崩溃
    return loadMcpTools(server.name, client);
  }

  /**
   * 连接池取用（单飞）：同 cacheKey 的并发调用共享同一个 connect Promise；
   * 连接失败时 close 已建立的 client（stdio 可能已拉起子进程，防泄漏）并
   * 删除单飞条目，下次调用重新连接。成功连接缓存在 mcpClients 供后续复用。
   */
  private async connectOrGet(server: McpServerRuntimeConfig): Promise<Client> {
    const cacheKey = this.buildCacheKey(server);
    const cached = this.mcpClients.get(cacheKey);
    if (cached) return cached;

    const inflight = this.pendingConnections.get(cacheKey);
    if (inflight) return inflight;

    const connecting = (async () => {
      const client = new Client({ name: 'tuanzi-agent', version: '1.0.0' }, { capabilities: {} });

      let transport;
      if (server.type === McpServerType.STDIO) {
        transport = new StdioClientTransport({
          command: server.command!,
          args: server.args ?? [],
          // 用户 env 与 SDK 默认环境（PATH 等）合并，否则子进程可能找不到可执行文件
          env: { ...getDefaultEnvironment(), ...(server.env ?? {}) },
        });
      } else {
        const options = server.headers ? { requestInit: { headers: server.headers } } : undefined;
        transport =
          server.type === McpServerType.SSE
            ? new SSEClientTransport(new URL(server.url!), options)
            : new StreamableHTTPClientTransport(new URL(server.url!), options);
      }

      try {
        // connect 加 10s 超时：MCP SDK Client.connect 第二参 RequestOptions.signal 支持中止
        await client.connect(transport, { signal: AbortSignal.timeout(10_000) });
      } catch (e) {
        // 连接失败：close 已建立的 client 防泄漏（stdio 子进程 / 半开连接）
        await client.close().catch(() => undefined);
        throw e;
      }

      this.mcpClients.set(cacheKey, client);
      return client;
    })();

    this.pendingConnections.set(cacheKey, connecting);
    try {
      return await connecting;
    } finally {
      // 无论成败都移除单飞条目：成功路径已由 mcpClients 承接，失败路径下次可重试
      this.pendingConnections.delete(cacheKey);
    }
  }

  /**
   * 以 transport + endpoint + env/headers 为 key，防止不同 URL/command/env/headers
   * 的配置复用错误连接。env/headers 属敏感配置，不直接拼进 key（避免日志/内存泄漏），
   * 用 sha256 摘要参与区分。
   */
  private buildCacheKey(server: McpServerRuntimeConfig): string {
    if (server.type === McpServerType.STDIO) {
      const envHash = server.env ? this.sha256(JSON.stringify(server.env)) : '';
      return `stdio:${server.command} ${(server.args ?? []).join(' ')}|env=${envHash}`;
    }
    const headersHash = server.headers ? this.sha256(JSON.stringify(server.headers)) : '';
    return `${server.type}:${server.url}|headers=${headersHash}`;
  }

  private sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
}
