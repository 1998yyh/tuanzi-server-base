#!/usr/bin/env bash
# 团子后台一键部署：同步源码 → 服务器 docker compose 重建并滚动重启 app
# 用法: bash deploy.sh
# 注意: MySQL 容器不动，只重建 app；服务器上的 .env.production / uploads 不会被覆盖
set -euo pipefail

SERVER="root@43.140.214.49"
REMOTE_DIR="/var/projects/tuanzi-server-base"
COMPOSE="docker compose -f docker-compose.prod.yml"

cd "$(dirname "$0")"

echo "==> 部署前置检查：生产库表结构 vs 代码实体"
bash scripts/check-prod-schema.sh

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

echo "==> 服务器上重建并重启 app 容器"
ssh "$SERVER" "cd $REMOTE_DIR && $COMPOSE up -d --build app"

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
