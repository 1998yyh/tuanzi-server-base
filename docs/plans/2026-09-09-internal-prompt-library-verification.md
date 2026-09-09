# 内部提示词库部署验收

2026-09-09 已部署后端及 personal-homepage 当前前端版本。前端包含任务开始前已有的生成台、导航与路由修改，用户在发布确认后回复「请继续」。代码保留在两个本地工作区，未代为提交或推送 Git。

## 数据结果

- 6 个源全部成功，正文共 1,201 条，存入服务器 MySQL `prompt_items`。
- 13 个用途分类；380 条规则未能明确判断的内容归「其他创意」，可在页面人工调整。
- 1,383 个唯一图片地址中，677 张成功下载并同步到服务器 `uploads/prompts/`（约 216 MB）。706 张失败，正文中的相应图片继续使用原链接。
- 失败分类：629 次网络 fetch 失败、5 次超时、70 次 HTTP 403、2 次 HTTP 404。详细 URL 清单位于服务器 `uploads/prompt-import/image-failures.json`。
- 唯一现有用户指定为公共提示词维护者，其 UserRole 仍为 `user`。
- DDL 已执行，并在 `ddl_history` 登记 `2026-09-09-internal-prompt-library.sql`。

## 验证

- 后端：`pnpm lint`、`pnpm build`、`pnpm typecheck` 通过；提示词相关 4 个测试文件、32 项测试通过。
- 全仓 Jest：39 个文件通过，2 个 Agent 测试文件失败（43 项）。在 HEAD 临时副本重跑这两个文件，同样 43 项失败，根因是已有测试未提供 DelegateToolFactory 等依赖，并非本次提示词修改新增。
- 独立 MySQL 测试库验证：导入、去重、重复导入保留编辑、软删除不复活、分类与标签、字面关键词搜索、分页、私有数据隔离；验证结束删除该测试库。
- HTTP 验证：新增、详情、修改、删除、DTO 空值/未知字段校验、普通用户越权拒绝；指定普通用户为词库维护者后可新增，全站角色保持不变。
- 前端：`pnpm lint` 无错误或警告；`VITE_API_URL=/api pnpm build` 通过。
- 本地浏览器使用模拟接口验证编辑保存、重新加载、分类筛选、删除与空状态、新增；页面无 JS 异常。
- 线上真实接口验证：total=1201，categories=13，canManage=true，返回条目 canEdit=true，账号 role=user；本地图片 HEAD 返回 200。
- 线上真实浏览器只读检查分类选择、编辑预填与取消、维护按钮，无 JS 异常。未修改用户已有提示词。
- 线上首页 HTTP 200；匿名请求词库 HTTP 401。

## 备份与部署

服务器 `/var/backups/tuanzi-prompts-20260909/` 保留旧后端模块和旧前端站点归档。旧后端镜像标记为 `tuanzi-prompts-before:20260909`。前端先同步新资源再原子替换 index.html，保留旧的哈希资源供已打开页面继续使用。

数据和图片随 MySQL、uploads 持久化；旧源后续变化不会覆盖已维护内容。回退服务代码时保留新数据表和 uploads，避免丢失已编辑内容。
