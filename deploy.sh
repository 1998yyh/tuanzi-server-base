#!/usr/bin/env bash
# 团子后台一键部署：同步源码 → 服务器构建镜像 → 跑数据库迁移 → 滚动重启 app
# 用法: bash deploy.sh
# 注意: MySQL 容器不动，只重建 app；服务器上的 .env.production / uploads 不会被覆盖
# 迁移: 切换 app 前自动执行 migration:run；存量库首次部署若报「表已存在」，
#       需先按 docs/plans/2026-08-07-migration-baseline.md 做 baseline
set -euo pipefail

SERVER="root@43.140.214.49"
REMOTE_DIR="/var/projects/tuanzi-server-base"
COMPOSE="docker compose -f docker-compose.prod.yml"

cd "$(dirname "$0")"

echo "==> 同步源码 -> $SERVER:$REMOTE_DIR"
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'coverage' \
  --exclude 'uploads' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '!.env.example' \
  ./ "$SERVER:$REMOTE_DIR/"

echo "==> 服务器上构建新镜像"
ssh "$SERVER" "cd $REMOTE_DIR && $COMPOSE build app"

echo "==> 执行数据库迁移（先于 app 切换，一次性容器内跑）"
# 容器里没 .env 文件，data-source.js 的 dotenv 读不到文件会自动回退到
# compose 注入的环境变量（DB_HOST=mysql 等），路径用编译后的 dist
if ! ssh "$SERVER" "cd $REMOTE_DIR && $COMPOSE run --rm app node ./node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js"; then
  echo "❌ 数据库迁移失败，已中止部署（app 未切换，线上不受影响）" >&2
  echo "   若是「Table already exists」类报错：存量库缺迁移记录，先做 baseline：" >&2
  echo "   docs/plans/2026-08-07-migration-baseline.md" >&2
  exit 1
fi

echo "==> 切换 app 容器到新版本"
ssh "$SERVER" "cd $REMOTE_DIR && $COMPOSE up -d app"

echo "==> 健康检查（等容器起来）"
for i in $(seq 1 15); do
  # /api/auth/login 不带参数应返回 400（ValidationPipe），说明 NestJS 已就绪
  code=$(ssh "$SERVER" "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/api/auth/login" || echo 000)
  if [ "$code" = "400" ]; then
    echo "✅ 部署完成，接口已就绪 (HTTP $code)"
    exit 0
  fi
  echo "   等待中... ($i/15, HTTP $code)"
  sleep 2
done
echo "❌ 健康检查失败，上去看日志: ssh $SERVER 'docker logs tuanzi-app --tail 50'" >&2
exit 1
