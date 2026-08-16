# 统一 LLM 凭据到 AI 渠道（Agent 不再内嵌凭据）

Agent 原本在自己表里内嵌 provider/apiKey/baseUrl/model 四字段，与 ai_channels 高度重复——同一网关的 key 要在两处各配一遍、轮换要改多处。我们决定让 ai_channels 成为全站唯一的模型凭据入口：capability 扩展「对话」（chat）用途，Agent 改为引用 channelId + modelName，运行时经 AiChannelsService.resolveChatModel 解密取凭据。存量数据由 scripts/migrate-agent-channels.ts 物化迁移，验证通过后以 --drop-legacy 删除旧四列（不可逆）。

**Considered Options**: ①保持两套凭据并存——重复配置、key 轮换改多处，否；②Channel 并入 Agent——丢掉「一个端点 × 多模型 × 用途」的资源池结构，画布的用途过滤无法实现，否；③「格式 × 用途」全矩阵校验——模型真实能力不由格式决定（兼容网关可代理任意模型），只保留 chat 方向的校验（chat 受限于 LangChain 客户端分发）。

**Consequences**: 删除被 Agent 引用的渠道会被 400 拦截并返回引用者清单（DB 层 FK RESTRICT 兜底）；删列后回滚旧代码会直接崩，接受该风险。
