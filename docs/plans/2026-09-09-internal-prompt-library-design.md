# 内部提示词库

提示词正文从远端抓取缓存改为 MySQL `prompt_items` 持久化。列表和 Agent 的提示词搜索使用同一服务，只查数据库。外部源保留为导入入口和来源记录，不在访问、启动或定时任务中同步。

## 维护规则

- 内置源导入公共库（`user_id=null`），由 `maintainer_id` 指定的账号维护自己的条目，`admin` 可维护全部公共条目；普通登录用户可浏览。已有公共条目维护者（包括已软删除的条目）可新增和追加导入。
- 旧用户自建源导入时保持用户私有，只有本人可查看和维护。
- 以 SHA-256(sourceId + 换行 + 原始 ID) 唯一去重，重复导入只补缺失项。不同源中的相同内容不强行合并，保留各自来源和版本。
- 删除写 `deleted_at`，列表与详情不返回删除项，唯一导入键仍保留。编辑使用 `deleted_at IS NULL` 条件更新，避免与删除并发时恢复记录。
- 用途分类由源标签优先、标题兜底的确定性规则生成；不确定项归入「其他创意」。维护者可任意填写分类（保留值 `all` 除外），原标签、作者和来源链接保留。
- 修改源启用状态只影响后续导入，不隐藏已经入库的提示词。

## 页面和接口

生成台「词库」提供搜索、分类和标签筛选、总数与分页。维护者点击标题栏新增按钮；展开卡片后可编辑或删除。编辑表单支持标题、正文、描述、分类、标签、封面和参考图片地址。

| 接口 | 行为 |
| --- | --- |
| GET /api/prompts | 列表；keyword、category、tag、sourceId、page、pageSize；响应保持 items/tags/categories/total，增加 canManage |
| POST /api/prompts | 维护者新增公共提示词 |
| GET /api/prompts/:id | 可见的单条详情 |
| PATCH /api/prompts/:id | 编辑并保存，保留来源信息 |
| DELETE /api/prompts/:id | 软删除，204 |
| POST /api/prompts/sources/:id/refresh | 兼容旧路由，语义为只追加导入 |
| POST /api/prompts/refresh-all | 导入当前用户可维护且启用的源，逐源报告成功/失败 |

单条响应新增 `sourceName`、`canEdit`。提示词 ID 改为本地 UUID；外部 ID 仅参与导入去重。前端媒体地址使用 `mediaUrl()` 兼容本地 `/uploads/`。

## 初次导入与部署

1. 执行 `2026-09-09-internal-prompt-library.sql`（正常部署由 DDL 流水线执行），保持 synchronize=false。
2. 在网络可达的机器运行：

   ```bash
   pnpm exec ts-node src/prompts/import-prompts.cli.ts snapshot --images
   ```

   默认读取 6 个预置源，正文快照位于 `uploads/prompt-import/sources.json`。图片保存在 `uploads/prompts/`，按原 URL 哈希复用文件，每个文件最大 20MB，跳转逐次校验公网地址，真实图片格式嗅探后原子落盘。下载失败保留外链，清单位于 `uploads/prompt-import/image-failures.json`；不将失败伪装成成功。可不带 `--images` 仅导入文本。
3. 将上述两个 uploads 子目录同步到服务器持久化 uploads 挂载。
4. 新镜像已构建时执行（只连接数据库，不启动业务定时器）：

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps app node dist/prompts/import-prompts.cli.js import
   ```

   工具通过 `--owner 用户UUID` 指定维护者；未指定时优先选管理员，没有管理员且只有一个账号时选该账号，多账号无管理员时要求明确指定。维护权仅属于词库，不修改用户全站角色。重复执行安全，不覆盖已有编辑。图片补拉后，对已经入库的条目应通过编辑接口更新地址；再次导入不会覆盖它们。
5. 验证数量、分类、编辑和删除后再启动新 app，发布对应前端。

源导入错误状态只保存在当前进程；重启后条数与最近入库记录时间从数据库读取。图像下载结果与正文快照独立保留，随服务器 uploads 一起备份。
