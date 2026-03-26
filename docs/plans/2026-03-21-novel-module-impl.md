# 小说模块实现计划

> 创建时间: 2026-03-21
> 设计文档: [2026-03-21-novel-module-design.md](./2026-03-21-novel-module-design.md)

## 任务分解

每个任务约 2-5 分钟，遵循 TDD: 写测试 → 测试失败 → 实现 → 测试通过 → 提交

---

## Part 1: 后端 (tuanzi-server-base)

### Task 1.1: 创建 Novel Entity
- 创建 `src/novels/novel.entity.ts`
- 定义字段: id, title, author, description, cover_url, word_count, chapter_count, status, created_at, updated_at
- 验证: 项目能编译通过

### Task 1.2: 创建 Chapter Entity
- 创建 `src/novels/chapter.entity.ts`
- 定义字段: id, novel_id, title, content, word_count, chapter_order, created_at, updated_at
- 配置与 Novel 的关联关系
- 验证: 项目能编译通过

### Task 1.3: 创建 NovelsModule
- 创建 `src/novels/novels.module.ts`
- 注册 Entity 到 TypeOrmModule
- 导入到 AppModule
- 验证: 项目能启动，数据库表自动创建

### Task 1.4: 创建 DTO
- 创建 `src/novels/dto/create-novel.dto.ts`
- 创建 `src/novels/dto/update-novel.dto.ts`
- 创建 `src/novels/dto/create-chapter.dto.ts`
- 创建 `src/novels/dto/update-chapter.dto.ts`
- 添加 class-validator 验证装饰器
- 验证: 项目能编译通过

### Task 1.5: 创建 NovelsService (CRUD 方法)
- 创建 `src/novels/novels.service.ts`
- 实现: findAll, findOne, create, update, remove
- 章节相关: findChapters, findChapter, createChapter, updateChapter, removeChapter
- 验证: 项目能编译通过

### Task 1.6: 创建 NovelsController (公开路由)
- 创建 `src/novels/novels.controller.ts`
- GET /novels - 小说列表
- GET /novels/:id - 小说详情
- GET /novels/:id/chapters - 章节列表
- GET /novels/:id/chapters/:chapterId - 章节内容
- 添加 Swagger 装饰器
- 验证: 启动服务，Swagger 文档显示路由

### Task 1.7: 创建 NovelsAdminController (管理路由)
- 创建 `src/novels/novels-admin.controller.ts`
- POST /novels - 创建小说 (需认证)
- PUT /novels/:id - 更新小说 (需认证)
- DELETE /novels/:id - 删除小说 (需认证)
- POST /novels/:id/chapters - 添加章节 (需认证)
- PUT /novels/:id/chapters/:chapterId - 更新章节 (需认证)
- DELETE /novels/:id/chapters/:chapterId - 删除章节 (需认证)
- 使用 @UseGuards(JwtAuthGuard)
- 验证: Swagger 文档显示管理路由，未认证返回 401

### Task 1.8: 单元测试
- 创建 `src/novels/novels.service.spec.ts`
- 测试 CRUD 方法
- 验证: npm test 通过

---

## Part 2: 前端 (personal-homepage)

### Task 2.1: 创建 API 服务
- 创建 `src/lib/novelsApi.ts`
- 定义 API 调用函数: getNovels, getNovel, getChapters, getChapter
- 使用 axios
- 验证: 项目能编译通过

### Task 2.2: 创建类型定义
- 创建 `src/types/novel.ts`
- 定义 Novel, Chapter 接口
- 验证: 项目能编译通过

### Task 2.3: 创建小说列表页
- 创建 `src/pages/NovelsPage.tsx`
- 使用 react-query 获取数据
- 展示小说卡片列表 (封面 + 书名 + 作者 + 简介)
- 验证: 页面能正常渲染

### Task 2.4: 创建小说详情页
- 创建 `src/pages/NovelDetailPage.tsx`
- 展示小说信息 (封面、简介、章节数等)
- 展示章节目录列表
- 点击章节跳转阅读页
- 验证: 页面能正常渲染

### Task 2.5: 创建阅读页面
- 创建 `src/pages/ChapterPage.tsx`
- 展示章节标题和内容
- 上一章/下一章导航
- 返回目录链接
- 验证: 页面能正常渲染，导航功能正常

### Task 2.6: 配置路由
- 修改 `src/App.tsx`
- 添加路由: /novels, /novels/:id, /novels/:id/chapters/:chapterId
- 添加导航链接
- 验证: 路由跳转正常

---

## Part 3: 集成测试

### Task 3.1: 端到端测试
- 启动后端服务
- 启动前端服务
- 测试完整流程: 列表 → 详情 → 阅读
- 验证: 所有功能正常

---

## 执行顺序

1. Part 1 (后端) - Task 1.1 ~ 1.8
2. Part 2 (前端) - Task 2.1 ~ 2.6  
3. Part 3 (集成) - Task 3.1

预计总耗时: 1-2 小时