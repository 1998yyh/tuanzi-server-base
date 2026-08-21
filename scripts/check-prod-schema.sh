#!/usr/bin/env bash
# 生产库表结构前置检查：代码 @Entity 表清单 vs 生产 SHOW TABLES
# 缺表直接 exit 1 拒绝部署，防止「代码上了表没建」的启动崩溃事故（2026-08-21 踩坑实录）
# 用法: bash scripts/check-prod-schema.sh
set -euo pipefail

SERVER="root@43.140.214.49"
REMOTE_DIR="/var/projects/tuanzi-server-base"

cd "$(dirname "$0")/.."

CODE_TABLES=$(mktemp)
PROD_TABLES=$(mktemp)
trap 'rm -f "$CODE_TABLES" "$PROD_TABLES"' EXIT

# 1) 代码侧：实体表清单（项目约定统一 @Entity('snake_case') 单引号写法）
grep -rhoE "@Entity\('[^']+'\)" src/ | sed -E "s/@Entity\('([^']+)'\)/\1/" | sort -u > "$CODE_TABLES"

if [ ! -s "$CODE_TABLES" ]; then
  echo "❌ 未从 src/ 提取到任何 @Entity 表名，grep 模式可能已不匹配实体写法，检查中止" >&2
  exit 1
fi

# 2) 生产侧：SHOW TABLES（凭据从服务器 .env.production 现读，不落本地）
ssh "$SERVER" '
  PW=$(grep -oP "^DB_ROOT_PASSWORD=\K.*" '"$REMOTE_DIR"'/.env.production)
  DB=$(grep -oP "^DB_DATABASE=\K.*" '"$REMOTE_DIR"'/.env.production)
  docker exec tuanzi-mysql mysql -uroot -p"$PW" "$DB" -N -e "SHOW TABLES" 2>/dev/null
' | sort -u > "$PROD_TABLES"

if [ ! -s "$PROD_TABLES" ]; then
  echo "❌ 读取生产库表清单失败（ssh/mysql 不可用或凭据错误），检查中止" >&2
  exit 1
fi

# 3) 差集：代码有而生产没有（反向不管——多对多中间表等仅存在于库中属正常）
MISSING=$(comm -23 "$CODE_TABLES" "$PROD_TABLES")

if [ -z "$MISSING" ]; then
  echo "✅ 生产库表结构检查通过（$(wc -l < "$CODE_TABLES" | tr -d ' ') 张实体表全部存在）"
  exit 0
fi

echo "❌ 生产库缺少以下表，拒绝部署：" >&2
echo "$MISSING" | sed 's/^/   - /' >&2
echo "" >&2
echo "修复方法：" >&2
for t in $MISSING; do
  # 在 docs/plans/ 里找包含该表建表语句的 SQL 文件，给运维直接可执行的提示
  SQL_FILES=$(grep -lE "CREATE TABLE \`?${t}\`?" docs/plans/*.sql 2>/dev/null || true)
  if [ -n "$SQL_FILES" ]; then
    echo "$SQL_FILES" | sed 's/^/   待执行: /' >&2
  else
    echo "   ⚠️ docs/plans/ 中未找到表 ${t} 的建表 SQL，请先补写 DDL 文件" >&2
  fi
done
echo "" >&2
echo "执行命令模板：" >&2
echo "   scp docs/plans/<文件>.sql ${SERVER}:/tmp/" >&2
echo "   ssh ${SERVER} 'docker exec -i tuanzi-mysql mysql -uroot -p\"<DB_ROOT_PASSWORD>\" tuanzi_server < /tmp/<文件>.sql'" >&2
echo "" >&2
echo "另请人工核对：近期实体若有字段/索引变更（新列、新索引），对应 ALTER/CREATE INDEX DDL 是否已在生产执行" >&2
exit 1
