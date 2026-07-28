import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { WebSearchTool } from './builtin/web-search.tool';
import { CalculatorTool } from './builtin/calculator.tool';

/**
 * 工具注册表：内置工具 + MCP 客户端连接池管理。
 *
 * - 内置工具按 name 注册，AgentConfig.enabledTools 按需取用
 * - MCP Server 由调用方（AgentExecutorService）从 mcp_servers 表加载解密后传入，
 *   Client 以 transport:endpoint 为 key 复用连接，模块销毁时统一关闭
 * - 单个 MCP Server 连接失败不阻断整体——跳过该 Server 并记录警告
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly builtinTools = new Map<string, StructuredToolInterface>();
  private readonly mcpClients = new Map<string, Client>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.builtinTools.set('web_search', new WebSearchTool(this.config));
    this.builtinTools.set('calculator', new CalculatorTool());
    // 后续新增内置工具在此注册
  }

  async onModuleDestroy() {
    for (const client of this.mcpClients.values()) {
      try {
        await client.close();
      } catch (e) {
        this.logger.warn(`关闭 MCP 连接失败: ${(e as Error).message}`);
      }
    }
    this.mcpClients.clear();
  }

  /** 返回全部内置工具名，供前端展示可选列表 */
  listBuiltinToolNames(): string[] {
    return [...this.builtinTools.keys()];
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
      } else {
        this.logger.warn(`Agent "${config.name}" 启用了不存在的内置工具: ${name}`);
      }
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

  private async connectOrGet(server: McpServerRuntimeConfig): Promise<Client> {
    const cacheKey = this.buildCacheKey(server);
    const cached = this.mcpClients.get(cacheKey);
    if (cached) return cached;

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

    await client.connect(transport);
    this.mcpClients.set(cacheKey, client);
    return client;
  }

  /** 以 transport + endpoint 为 key，防止不同 URL/args 的配置复用错误连接 */
  private buildCacheKey(server: McpServerRuntimeConfig): string {
    return server.type === McpServerType.STDIO
      ? `stdio:${server.command} ${(server.args ?? []).join(' ')}`
      : `${server.type}:${server.url}`;
  }
}
