# 小说模块设计文档

> 创建时间: 2026-03-21
> 状态: 已批准

## 需求概述

在 tuanzi-server-base 和 personal-homepage 中增加小说模块，用于展示和管理 AI 生成的小说内容。

## 需求决策

| 项 | 决策 |
|---|------|
| 存储 | MySQL 数据库 |
| 功能 | 阅读端 + 后端管理 API，前端管理页暂缓 |
| 内容 | 纯文本章节 + 封面图片 |
| 进度/书签 | 暂不需要 |
| 分类/标签 | 暂不需要 |

## 数据模型

### novels (小说表)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT | 主键，自增 |
| title | VARCHAR(255) | 书名 |
| author | VARCHAR(100) | 作者 |
| description | TEXT | 简介 |
| cover_url | VARCHAR(500) | 封面图片 URL |
| word_count | INT | 总字数，默认 0 |
| chapter_count | INT | 章节数，默认 0 |
| status | TINYINT | 状态: 0-连载中, 1-已完结 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### chapters (章节表)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT | 主键，自增 |
| novel_id | INT | 所属小说 ID，外键 |
| title | VARCHAR(255) | 章节标题 |
| content | LONGTEXT | 章节内容 |
| word_count | INT | 本章字数 |
| chapter_order | INT | 章节序号 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

## API 设计

### 阅读端 (公开)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/novels | 小说列表 (分页) |
| GET | /api/novels/:id | 小说详情 |
| GET | /api/novels/:id/chapters | 章节列表 |
| GET | /api/novels/:id/chapters/:chapterId | 章节内容 |

### 管理端 (需 JWT 认证)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/novels | 创建小说 |
| PUT | /api/novels/:id | 更新小说信息 |
| DELETE | /api/novels/:id | 删除小说 |
| POST | /api/novels/:id/chapters | 添加章节 |
| PUT | /api/novels/:id/chapters/:chapterId | 更新章节 |
| DELETE | /api/novels/:id/chapters/:chapterId | 删除章节 |

## 前端页面

1. **小说列表页** `/novels` - 展示所有小说卡片
2. **小说详情页** `/novels/:id` - 简介 + 章节目录
3. **阅读页面** `/novels/:id/chapters/:chapterId` - 章节内容阅读

## 技术实现

### 后端 (tuanzi-server-base)

- NestJS 模块: `novels`
- Entity: `Novel`, `Chapter`
- CRUD Service
- Controller (公开 + 认证路由)
- DTO 验证
- Swagger 文档

### 前端 (personal-homepage)

- React Router 路由配置
- 页面组件: NovelsPage, NovelDetailPage, ChapterPage
- API 调用: axios + react-query
- 样式: Tailwind CSS