import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ToolRegistryService } from 'src/agents/tools/tool-registry.service';
import {
  AgentConfig,
  McpServerConfig,
  ProviderType,
} from 'src/agents/entities/agent-config.entity';

// 这些 mock 必须在 import 之前声明，jest.mock 会被提升到顶部。
// 注意：工厂函数在模块导入时执行（早于下方 const 初始化），
// 所以 mock 变量只能放在闭包里延迟引用，不能直接作为值导出（TDZ 报错）
const mockConnect = jest.fn();
const mockClose = jest.fn();
const mockLoadMcpTools = jest.fn();

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    close: (...args: unknown[]) => mockClose(...args),
  })),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation((opts) => ({ ...opts, kind: 'stdio' })),
}));
jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn().mockImplementation((url) => ({ url, kind: 'sse' })),
}));
jest.mock('@langchain/mcp-adapters', () => ({
  loadMcpTools: (...args: unknown[]) => mockLoadMcpTools(...args),
}));

describe('ToolRegistryService', () => {
  let service: ToolRegistryService;

  const getClientCtor = () =>
    (jest.requireMock('@modelcontextprotocol/sdk/client/index.js') as { Client: jest.Mock }).Client;

  const buildAgent = (override: Partial<AgentConfig> = {}): AgentConfig =>
    ({
      id: 'agent-1',
      name: '测试助手',
      provider: ProviderType.ANTHROPIC,
      enabledTools: [],
      mcpServers: [],
      ...override,
    }) as AgentConfig;

  const sseServer: McpServerConfig = {
    name: '远程工具',
    transport: 'sse',
    url: 'https://mcp.example.com/sse',
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

    it('不存在的内置工具名应该跳过并警告，不影响其他工具', async () => {
      const tools = await service.getToolsForAgent(
        buildAgent({ enabledTools: ['calculator', 'nonexistent'] }),
      );

      expect(tools).toHaveLength(1);
    });

    it('listBuiltinToolNames 应该返回全部已注册工具名', () => {
      expect(service.listBuiltinToolNames()).toEqual(
        expect.arrayContaining(['web_search', 'calculator']),
      );
    });
  });

  describe('MCP 工具', () => {
    it('应该连接 MCP Server 并用 loadMcpTools 加载工具（首参为 serverName）', async () => {
      const tools = await service.getToolsForAgent(buildAgent({ mcpServers: [sseServer] }));

      expect(getClientCtor()).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockLoadMcpTools).toHaveBeenCalledWith('远程工具', expect.anything());
      expect(tools).toEqual([{ name: 'mcp_tool' }]);
    });

    it('相同 transport + endpoint 的配置应该复用连接', async () => {
      const sameUrlServer: McpServerConfig = { ...sseServer, name: '另一个名字' };

      await service.getToolsForAgent(buildAgent({ mcpServers: [sseServer] }));
      await service.getToolsForAgent(buildAgent({ mcpServers: [sameUrlServer] }));

      // 连接只建立一次（cacheKey = transport:url，与 name 无关）
      expect(getClientCtor()).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('MCP 连接失败应该跳过该 Server 而不阻断整体', async () => {
      mockConnect.mockRejectedValue(new Error('connection refused'));

      const tools = await service.getToolsForAgent(
        buildAgent({
          enabledTools: ['calculator'],
          mcpServers: [sseServer],
        }),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('calculator');
    });

    it('onModuleDestroy 应该关闭全部 MCP 连接', async () => {
      await service.getToolsForAgent(buildAgent({ mcpServers: [sseServer] }));

      await service.onModuleDestroy();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
