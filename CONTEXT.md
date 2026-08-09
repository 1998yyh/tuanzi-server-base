# 团子后台（tuanzi-server-base）

个人工具平台「Web Tools API」的后端服务：为 SPA 前端提供 AI 对话、AI 生成、日报、画布等能力。

## 语言

**AiChannel（AI 渠道）**:
一个 AI 接口端点（apiFormat + baseUrl + apiKey）加其下的模型清单；全站唯一的模型凭据管理入口，对话与生成共用。
_避免使用_: LLM 配置、连接、provider 配置

**用途（capability）**:
渠道下单个模型的用途标签：对话 / 图片 / 视频 / 音频。UI 文案与错误消息一律用「用途」，代码标识符为 capability。
_避免使用_: 能力、类型、模式

**Agent**:
一个对话实体：引用某渠道的「对话」用途模型，外加行为配置（系统提示词/工具/迭代上限）。凭据不属于 Agent。
_避免使用_: 机器人、助手配置
