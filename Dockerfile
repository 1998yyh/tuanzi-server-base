# syntax=docker/dockerfile:1

# ---------- 构建阶段：编译 TS ----------
FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# 容器里没有 .git，husky 装钩子会报错，直接禁掉
ENV HUSKY=0

RUN corepack enable && corepack prepare pnpm@10.32.0 --activate

WORKDIR /app

# 先拷依赖清单，吃 Docker 层缓存（源码变了不用重装依赖）
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

# 生产环境没有 devDependencies，husky 不存在，先把 prepare 脚本删掉防止 pnpm install 炸掉
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.scripts.prepare;fs.writeFileSync('package.json',JSON.stringify(p,null,2))"

# 重新装一份纯生产依赖（bcrypt 原生模块在这步编译）
RUN pnpm install --frozen-lockfile --prod


# ---------- 运行阶段：只带 dist + 生产依赖 ----------
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# uploads/ 静态目录由 compose 挂载，这里先建出来避免权限问题
RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "dist/main"]
