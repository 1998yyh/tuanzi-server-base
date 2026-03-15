# Tuanzi Server Base

团子后台基础服务，提供用户认证功能。

## 技术栈

- **框架**: NestJS 10 + TypeScript
- **数据库**: MySQL 8.0 + TypeORM
- **认证**: JWT + Passport
- **文档**: Swagger
- **包管理**: pnpm

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动数据库

```bash
docker-compose up -d
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，修改数据库密码和 JWT 密钥
```

### 4. 启动开发服务器

```bash
pnpm start:dev
```

服务启动后：
- API 地址: http://localhost:3000/api
- Swagger 文档: http://localhost:3000/api/docs

## API 接口

### 认证模块

| 方法 | 路径 | 描述 | 认证 |
|------|------|------|------|
| POST | /api/auth/register | 用户注册 | 否 |
| POST | /api/auth/login | 用户登录 | 否 |
| GET | /api/auth/profile | 获取用户信息 | 是 |
| POST | /api/auth/refresh | 刷新令牌 | 是 |

### 注册请求示例

```json
{
  "email": "user@example.com",
  "username": "johndoe",
  "password": "Password123!"
}
```

### 登录请求示例

```json
{
  "login": "user@example.com",
  "password": "Password123!"
}
```

### 登录响应示例

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 7200
}
```

## 项目结构

```
src/
├── main.ts                 # 应用入口
├── app.module.ts           # 根模块
├── auth/                   # 认证模块
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── jwt.strategy.ts
│   └── dto/
│       ├── register.dto.ts
│       └── login.dto.ts
├── users/                  # 用户模块
│   ├── users.module.ts
│   ├── users.service.ts
│   ├── users.entity.ts
│   └── dto/
│       └── user.dto.ts
└── common/                 # 公共模块
    ├── guards/
    ├── decorators/
    └── filters/
```

## 环境变量说明

| 变量 | 描述 | 默认值 |
|------|------|--------|
| NODE_ENV | 运行环境 | development |
| PORT | 服务端口 | 3000 |
| DB_HOST | 数据库地址 | localhost |
| DB_PORT | 数据库端口 | 3306 |
| DB_USERNAME | 数据库用户名 | root |
| DB_PASSWORD | 数据库密码 | - |
| DB_DATABASE | 数据库名 | tuanzi_server |
| JWT_SECRET | JWT 密钥 | - |
| CORS_ORIGINS | CORS 允许的域名 | * |

## 数据库管理

使用 Adminer 管理 MySQL：
- 地址: http://localhost:8080
- 系统: MySQL
- 服务器: mysql
- 用户名: root
- 密码: root_password
- 数据库: tuanzi_server

## 生产部署

1. 设置环境变量 `NODE_ENV=production`
2. 设置强密码和安全的 JWT_SECRET
3. 设置 `synchronize: false` 或使用迁移
4. 使用 `pnpm build` 构建后运行 `pnpm start:prod`

## License

ISC