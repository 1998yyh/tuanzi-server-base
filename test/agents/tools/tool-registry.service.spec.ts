import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ToolRegistryService } from 'src/agents/tools/tool-registry.service';
import { AgentConfig, ProviderType } from 'src/agents/entities/agent-config.entity';
import { McpServerRuntimeConfig, McpServerType } from 'src/mcp-servers/mcp-server.entity';

// 这些 mock 必须在 import 之前声明，jest.mock 会被提升到顶部。
// 注意：工厂函数在模块导入时执行（早于下方 const 初始化），
// 所以 mock 变量只能放在闭包里延迟引用，不能直接作为值导出（TDZ 报错）
const mockConnect = jest.fn();
const mockClose = jest.fn();
const mockLoadMcpTools = jest.fn();
const mockStdioTransport = jest.fn();
const mockSseTransport = jest.fn();
const mockHttpTransport = jest.fn();

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    close: (...args: unknown[]) => mockClose(...args),
  })),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  // 必须可被 new 调用（实现里是 new StdioClientTransport(...)），
  // 所以用普通 function 转发到 mockStdioTransport 记录调用，不能用箭头函数
  StdioClientTransport: function (...args: unknown[]) {
    mockStdioTransport(...args);
  },
  getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
}));
jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: function (...args: unknown[]) {
    mockSseTransport(...args);
  },
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: function (...args: unknown[]) {
    mockHttpTransport(...args);
  },
}));
jest.mock('@langchain/mcp-adapters', () => ({
  loadMcpTools: (...args: unknown[]) => mockLoadMcpTools(...args),
}));

describe('ToolRegistryService', () => {
  let service: ToolRegistryService;

  const buildAgent = (override: Partial<AgentConfig> = {}): AgentConfig =>
    ({
      id: 'agent-1',
      name: '测试助手',
      provider: ProviderType.ANTHROPIC,
      enabledTools: [],
      ...override,
    }) as AgentConfig;

  const sseServer: McpServerRuntimeConfig = {
    name: '远程工具',
    type: McpServerType.SSE,
    url: 'https://mcp.example.com/sse',
  };

  const stdioServer: McpServerRuntimeConfig = {
    name: '文件系统',
    type: McpServerType.STDIO,
    command: 'npx',
    args: ['-y', 'server-fs'],
    env: { ROOT: '/tmp' },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockLoadMcpTools.mockResolvedValue([{ name: 'mcp_tool' }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolRegistryService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, def?: unknown) => def) },
        },
      ],
    }).compile();

    service = module.get(ToolRegistryService);
    service.onModuleInit();
  });

  describe('内置工具', () => {
    it('应该按 enabledTools 过滤内置工具', async () => {
      const tools = await service.getToolsForAgent(buildAgent({ enabledTools: ['calculator'] }));

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('calculator');
    });

    it('listBuiltinToolNames 应该返回全部已注册工具名', () => {
      expect(service.listBuiltinToolNames()).toEqual(
        expect.arrayContaining(['web_search', 'calculator']),
      );
    });

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
  });

  describe('MCP 工具', () => {
    it('sse 类型应该用 SSEClientTransport 连接并加载工具', async () => {
      const tools = await service.getToolsForAgent(buildAgent(), [sseServer]);

      expect(mockSseTransport).toHaveBeenCalledTimes(1);
      expect(mockSseTransport.mock.calls[0][0]).toBeInstanceOf(URL);
      expect(String(mockSseTransport.mock.calls[0][0])).toBe('https://mcp.example.com/sse');
      expect(mockLoadMcpTools).toHaveBeenCalledWith('远程工具', expect.anything());
      expect(tools).toEqual([{ name: 'mcp_tool' }]);
    });

    it('带 headers 的 server 应该把 headers 放入 requestInit', async () => {
      const withHeaders: McpServerRuntimeConfig = {
        ...sseServer,
        headers: { Authorization: 'Bearer abc' },
      };

      await service.getToolsForAgent(buildAgent(), [withHeaders]);

      expect(mockSseTransport.mock.calls[0][1]).toEqual({
        requestInit: { headers: { Authorization: 'Bearer abc' } },
      });
    });

    it('streamable-http 类型应该用 StreamableHTTPClientTransport', async () => {
      const httpServer: McpServerRuntimeConfig = {
        name: 'http 工具',
        type: McpServerType.STREAMABLE_HTTP,
        url: 'https://mcp.example.com/mcp',
      };

      await service.getToolsForAgent(buildAgent(), [httpServer]);

      expect(mockHttpTransport).toHaveBeenCalledTimes(1);
      expect(String(mockHttpTransport.mock.calls[0][0])).toBe('https://mcp.example.com/mcp');
    });

    it('stdio 类型应该传 command/args，env 与默认环境合并', async () => {
      await service.getToolsForAgent(buildAgent(), [stdioServer]);

      expect(mockStdioTransport).toHaveBeenCalledWith({
        command: 'npx',
        args: ['-y', 'server-fs'],
        env: { PATH: '/usr/bin', ROOT: '/tmp' },
      });
    });

    it('相同 url 的 server（不同名字）应该复用连接', async () => {
      await service.getToolsForAgent(buildAgent(), [sseServer]);
      await service.getToolsForAgent(buildAgent(), [{ ...sseServer, name: '另一个名字' }]);

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('相同 command 不同 args 的 stdio server 不应该复用连接', async () => {
      await service.getToolsForAgent(buildAgent(), [stdioServer]);
      await service.getToolsForAgent(buildAgent(), [{ ...stdioServer, args: ['-y', 'other'] }]);

      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it('MCP 连接失败应该跳过该 Server 而不阻断整体', async () => {
      mockConnect.mockRejectedValue(new Error('connection refused'));

      const tools = await service.getToolsForAgent(buildAgent({ enabledTools: ['calculator'] }), [
        sseServer,
      ]);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('calculator');
    });

    it('onModuleDestroy 应该关闭全部 MCP 连接', async () => {
      await service.getToolsForAgent(buildAgent(), [sseServer]);

      await service.onModuleDestroy();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
