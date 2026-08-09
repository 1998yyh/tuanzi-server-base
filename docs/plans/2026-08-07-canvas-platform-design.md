# 无限画布平台设计文档（infinite-canvas 功能迁移）

日期：2026-08-06 ～ 2026-08-07
范围：tuanzi-server-base（NestJS 后端）+ personal-homepage（Vue 3 前端）
来源：本地开源项目 `infinite-canvas`（React 19 + Zustand，纯前端，AGPL-3.0）

## 1. 迁移目标与范围

将 infinite-canvas 的四大能力迁移到自有前后端：

- **画布核心**：6 种节点（image/text/config/video/audio/group）、连线、框选、撤销重做、分组
- **AI 生成**：图片 / 视频 / 音频三种 capability，OpenAI 兼容 + Gemini + 火山方舟（Seedance）三种 apiFormat
- **Agent 操作画布**：16 个后端工具 + 「画布助手」Skill
- **提示词库 / 素材库**：远程提示词源抓取 + 个人素材收藏

**明确不做**：

- 插件系统（plugin-loader / plugin-registry / plugin-runtime 不迁移）
- **自定义调用脚本 v1 不支持**：源项目允许渠道模型挂一段 JS 脚本在浏览器里 `new Function` 执行来自定义请求。服务端执行用户脚本 = RCE 风险，v1 拒绝该能力；`ai_channels.models` 的 `script` 字段保留在类型里但后端忽略。如未来需要，走沙箱（isolated-vm 之类）独立评审后再加。
- 浏览器 IndexedDB 存储、反向 RPC（CanvasAssistant* 浏览器端 Agent 方案）：画布数据改存后端 MySQL。

## 2. 总体架构

```
Vue 3 前端 (personal-homepage)                NestJS 后端 (tuanzi-server-base)
┌─────────────────────────┐                  ┌──────────────────────────────┐
│ /canvas 画布列表+编辑器   │  REST (debounced │ canvas_projects (document   │
│  Pinia store + composable│  PUT + 乐观锁)   │  JSON 列 + version 乐观锁)   │
│ /channels AI 渠道管理    │ ───────────────► │ CanvasOpsService (单一写路径) │
│ /prompts 提示词库        │                  │ ai_channels (key AES-256-GCM) │
│ /assets 素材库           │                  │ generation_tasks + cron 轮询  │
└─────────────────────────┘                  │ media_files (/uploads/media)  │
                                             │ Agent 画布工具 16 个          │
                                             └──────────────────────────────┘
```

模块依赖方向（无环）：

```
CanvasModule ← AiGenerationModule ← AgentsModule
             ← PromptsModule    ↗
             ← AssetsModule    ↗
```

CanvasModule 不依赖任何生成模块；AiGenerationModule 导入 CanvasModule（回填节点）；AgentsModule 导入全部四个。ScheduleModule.forRoot() 在 AgentsModule 注册（全局）。

## 3. 核心设计决策

### 3.1 画布文档 = 单个 JSON 列 + 乐观锁

`canvas_projects.document` 存整文档 `{nodes, connections, viewport}`，不分节点表。所有写路径统一走 `CanvasDocumentService.applyMutation(projectId, expectedVersion, mutator)`：

```sql
UPDATE canvas_projects SET document = ?, version = version + 1
WHERE id = ? AND version = ?
```

影响行数 = 0 → 409 ConflictException「画布已被其他操作修改，请刷新后重试」。

三条写路径都遵守：
1. 前端 PUT /canvas-projects/:id（带 baseVersion）
2. Agent 工具 → CanvasOpsService.applyOps（不传单版本，基于最新版应用，无 409）
3. 生成回填 → CanvasOpsService.patchNodeMetadata（最新版单节点 metadata patch，无 409）

### 3.2 AI 生成后端代理

- API Key AES-256-GCM 加密落 `ai_channels.api_key_encrypted`（密钥 `AGENT_ENCRYPTION_KEY`，与 agents 模块共用 `src/common/utils/crypto.util.ts`），响应只给 maskedApiKey。
- 模型选择编码 `"channelId::modelName"`，由 `GenerationService.resolveChannelModel` 统一解析 + 按 capability 校验。
- provider 是纯函数，配置注入 `ResolvedChannelConfig {baseUrl, apiKey, apiFormat, model}`，全局 fetch + AbortSignal.timeout，中文错误。
- **b64 二进制永远不进 DB / 画布文档 / API 响应**：生成结果一律落 `./uploads/media/` + `media_files` 行，只传 URL（`/uploads/` 静态服务在 `/api` 前缀之外，前端拼 URL 用 `mediaUrl()`）。

### 3.3 视频生成任务化（异步）

图片/音频同步（120s timeout）；视频异步：

```
POST /ai-generation/videos → 立即返回 task（PENDING）
  → createVideoTask 拿 remoteTaskId → PROCESSING
  → @Cron(EVERY_10_SECONDS) poller 串行轮询（每任务最小间隔 5s，批次 50）
  → 成功：下载 → saveBuffer → SUCCEEDED + patchNodeMetadata 回填节点
  → 失败 / 30min 超时：FAILED + 节点 error 态
```

前端配合：`useNodeGeneration.runVideo` 先建 pending 节点并 `await store.saveNow()`（poller 回填要求节点已在 DB 文档里），再带 `nodeRef {projectId, nodeId}` 创建任务；`useGenerationTaskWatcher` 每 2s 查任务，终态时 `store.syncVersion()` 静默重载。

### 3.4 无 WebSocket 的协同

前端 focus 时 + 每 30s 比对 `version`，不同则整文档重拉；409 时弹「画布已被其他操作修改」模态，以后端为准。Agent 工具冲突自动 reload 重试一次。poller 单实例假设（多实例部署需 leader 锁，当前不管）。

### 3.5 Agent 工具后端执行（Pattern B）

16 个工具经 `ToolRegistryService.registerAgentScopedTool` 注册（scheduled-tasks 同款模式），工具 func 闭包捕获 agentConfigId → 查 AgentConfig 得 userId → 归属校验。高层工具（如 `canvas_create_image_prompt_flow`）经 `buildCanvasOps` 编译为 ops 批量 → CanvasOpsService 单一写路径。`run_generation` op 由 CanvasToolsService 消费，直接调 GenerationService。

工具清单：canvas_list_projects / canvas_get_state / canvas_create_node / canvas_create_text_node(s) / canvas_create_config_node / canvas_update_node / canvas_update_node_text / canvas_move_nodes / canvas_resize_node / canvas_delete_nodes / canvas_connect_nodes / canvas_create_image_prompt_flow / canvas_apply_ops / canvas_run_generation / generation_get_status / prompts_search / assets_list / assets_add。

「画布助手」Skill（`canvas_assistant`）由 SkillsService.onApplicationBootstrap 幂等种子（按 name 查重），createdBy = 首个 admin 用户（无则跳过 + warn，下次启动重试），systemPrompt 改写自 `canvas-agent/agent-instructions.md`（浏览器 MCP 词汇 → 后端工具词汇）。

### 3.6 提示词库不入库

`prompt_sources` 只存源（URL、内置标记、启用开关），内容每次抓取 + 内存 Map 缓存 1h SWR。内置 6 源 onApplicationBootstrap 按 URL 幂等种子，跨用户共享（userId 为 null）；内置源只允许切换 isActive，改名/改 URL/删除被拒绝。归一化：去重、自动 id（`${sourceId}-${序号}`）、相对 URL 转绝对。

### 3.7 素材库

`assets` 表 kind text/image/video：文本存 `text_content` 列；图片/视频挂 `media_id` FK（媒体删除时 SET NULL，素材行保留）。`assets_add` Agent 工具接受 content（文本）或 imageUrl（http URL 或 dataURL，50MB 上限，服务端下载 → saveBuffer source=IMPORT）。

## 4. 数据库 DDL

均为手写 DDL（synchronize: false 约定），需手动在 Adminer 执行：

- `2026-08-06-phase1-media-ai-generation.sql` — media_files / ai_channels / generation_tasks
- `2026-08-06-phase2-canvas.sql` — canvas_projects
- `2026-08-07-phase4-prompts.sql` — prompt_sources
- `2026-08-07-phase5-assets.sql` — assets

## 5. 前端要点

- Pinia `stores/canvas.ts` 是文档态唯一权威：`applyLocal(mutator)` 不可变更新 + 180ms debounce commitHistory（上限 50 快照）+ 500ms debounce PUT；拖拽暂停提交，结束单次 commit。
- 交互拆 6 个 composable（viewport/drag/resize/marquee/connection/keyboard），对照源 project.tsx（3044 行）的交互半。
- 渲染：DOM + CSS transform 世界 div（非 canvas 元素），SVG cubic bezier 连线，视口剔除 +280px。
- 导出：fflate zip（level 0），`canvas-export.ts` 导项目（project.json + 媒体文件）/导选中节点；`assets-export.ts` 素材 zip 导入导出（assets.json 清单，无清单时按扩展名推断）。
- 与源项目的关键差异：媒体 URL 走 `mediaUrl()` 补 API origin（`/uploads/` 不在 `/api` 前缀下）。

## 6. AGPL-3.0 合规

- 逐行移植文件头注 `// Ported from infinite-canvas (...), AGPL-3.0. See NOTICE.`
- React→Vue / 浏览器→后端改写文件头注 `// Adapted from ...`
- 两仓库根各加 NOTICE，列明移植/改写范围

## 7. 风险与遗留

1. 视频轮询禁止在请求生命周期内 await——cron poller + 前端轮询（v1 无 WS/SSE 推送）
2. 自定义调用脚本 v1 服务端拒绝执行（RCE 风险），见 §1
3. CORS：联调需后端 `CORS_ORIGINS` 放行 `http://localhost:5173`
4. 内置提示词源的 isActive 开关改的是共享行（个人应用 v1 可接受）
5. poller 单实例假设
