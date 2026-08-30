#!/usr/bin/env bash
# 自动执行 docs/plans/*.sql，用 ddl_history 表记账，跳过已执行的，按文件名顺序执行新的。
# 任一失败即退出非 0（调用方据此中止部署，不启动新 app）。
# 在服务器上、部署 app 之前运行。依赖：docker、运行中的 tuanzi-mysql 容器、当前目录有 .env。
set -euo pipefail

# 非交互 SSH 会话可能不含 /usr/local/bin（docker 所在），显式补上
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

cd "$(dirname "$0")/.."

MYSQL_CONTAINER="${MYSQL_CONTAINER:-tuanzi-mysql}"
DB_NAME="${DB_DATABASE:-tuanzi_server}"
PLANS_DIR="docs/plans"

# root 密码从 .env 读取（compose 插值用的同一份）
RP=$(grep "^DB_ROOT_PASSWORD=" .env | cut -d= -f2-)
if [ -z "$RP" ]; then
  echo "ERROR: 无法从 .env 读取 DB_ROOT_PASSWORD" >&2
  exit 1
fi

mysql_exec() {
  docker exec -i "$MYSQL_CONTAINER" mysql -uroot -p"$RP" "$DB_NAME" 2>&1 | grep -v "Using a password" || true
}

# 确保记账表存在（幂等）
mysql_exec <<'SQL'
CREATE TABLE IF NOT EXISTS ddl_history (
  filename VARCHAR(255) NOT NULL PRIMARY KEY,
  executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
SQL

# 已执行集合
applied=$(docker exec -i "$MYSQL_CONTAINER" mysql -uroot -p"$RP" "$DB_NAME" -N -e \
  "SELECT filename FROM ddl_history;" 2>/dev/null | grep -v "Using a password" || true)

shopt -s nullglob
pending=0
for path in $(ls "$PLANS_DIR"/*.sql 2>/dev/null | sort); do
  fname=$(basename "$path")
  if echo "$applied" | grep -qxF "$fname"; then
    continue
  fi
  pending=$((pending + 1))
  echo "==> 执行 DDL: $fname"
  # 失败即中止：先在事务外执行（DDL 多为隐式提交），出错则退出非 0
  if ! docker exec -i "$MYSQL_CONTAINER" mysql -uroot -p"$RP" "$DB_NAME" < "$path" 2>/tmp/ddl_err; then
    echo "ERROR: DDL 执行失败: $fname" >&2
    cat /tmp/ddl_err >&2
    exit 1
  fi
  # 成功后记账
  docker exec -i "$MYSQL_CONTAINER" mysql -uroot -p"$RP" "$DB_NAME" \
    -e "INSERT INTO ddl_history(filename) VALUES (\"$fname\");" 2>&1 | grep -v "Using a password" || true
  echo "    ✅ $fname 已执行并记账"
done

if [ "$pending" -eq 0 ]; then
  echo "==> 无待执行 DDL，数据库已是最新"
else
  echo "==> 完成 $pending 个 DDL"
fi
