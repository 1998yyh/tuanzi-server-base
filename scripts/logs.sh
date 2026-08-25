#!/usr/bin/env bash
# 生产日志查询：接口报错排障一条龙（pino JSON 结构化日志，jq 服务器侧过滤，日志不出服务器）
#
# 用法:
#   bash scripts/logs.sh                        # 最近 1h 的 WARN+ERROR（排障默认）
#   bash scripts/logs.sh --since 30m            # 时间窗（docker logs --since 语法：30m / 2h / 2026-08-24T10:00:00）
#   bash scripts/logs.sh --level error          # 级别下限：error / warn / info / debug
#   bash scripts/logs.sh --path ai-channels     # 按接口路径片段过滤
#   bash scripts/logs.sh --grep "channel_id"    # 按消息/错误内容模糊匹配
#   bash scripts/logs.sh --tail 200             # 只取容器末尾 200 行再过滤
#   bash scripts/logs.sh --raw                  # 输出原始 JSON 行（自行 jq 深加工）
#
# 组合示例：接口 500 排障
#   bash scripts/logs.sh --since 2h --level error --path conversations
set -euo pipefail

SERVER="root@43.140.214.49"
SINCE="1h"
LEVEL="warn"
PATH_Q=""
GREP_Q=""
TAIL=""
RAW=0

usage() { sed -n '2,15p' "$0"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --level) LEVEL="$2"; shift 2 ;;
    --path)  PATH_Q="$2"; shift 2 ;;
    --grep)  GREP_Q="$2"; shift 2 ;;
    --tail)  TAIL="$2"; shift 2 ;;
    --raw)   RAW=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

# 级别 → pino 数字（含更高级别：传 error 只看 50，传 warn 看 40+50）
case "$LEVEL" in
  error) LV=50 ;; warn) LV=40 ;; info) LV=30 ;; debug) LV=20 ;;
  *) echo "非法级别: $LEVEL（可选 error/warn/info/debug）" >&2; exit 1 ;;
esac

# 用户输入转义双引号，防 jq 程序被截断
PATH_Q="${PATH_Q//\"/\\\"}"
GREP_Q="${GREP_Q//\"/\\\"}"

# 过滤链：级别 + 路径 + 全文
FILTER="select(.level >= $LV)"
[ -n "$PATH_Q" ] && FILTER="$FILTER | select((.req.url // \"\") | contains(\"$PATH_Q\"))"
[ -n "$GREP_Q" ] && FILTER="$FILTER | select(((.msg // \"\") + \" \" + (.err.message // \"\")) | contains(\"$GREP_Q\"))"

# 美化格式：时间 [级别] 消息 + 请求行 + 错误摘要
FORMAT='def lv: if .level>=50 then "ERROR" elif .level>=40 then "WARN " elif .level>=30 then "INFO " else "DEBUG" end;
"\(.time) [\(lv)] \(.msg // "-")\(if .req then "  \(.req.method) \(.req.url) → \(.res.statusCode // "?")" else "" end)\(if .responseTime then " (\(.responseTime | floor)ms)" else "" end)\(if .err then "\n    ↳ \(.err.type): \(.err.message)" else "" end)"'

REMOTE_FILTER="jq -c '$FILTER'"
[ "$RAW" -eq 1 ] && REMOTE_FILTER="cat"
REMOTE_FORMAT="jq -r '$FORMAT'"
[ "$RAW" -eq 1 ] && REMOTE_FORMAT="cat"

# shellcheck disable=SC2087  # heredoc 刻意本地展开：$SINCE/$REMOTE_FILTER 需在客户端拼好再传
RESULT=$(ssh "$SERVER" bash -s <<REMOTE
docker logs tuanzi-app --since "$SINCE" ${TAIL:+--tail "$TAIL"} 2>&1 \
  | jq -R 'fromjson? // empty' \
  | $REMOTE_FILTER \
  | $REMOTE_FORMAT
REMOTE
)

if [ -z "$RESULT" ]; then
  echo "(无匹配日志：最近 $SINCE 内没有满足条件的记录)"
else
  echo "$RESULT"
  echo "---"
  echo "共 $(echo "$RESULT" | grep -c .) 条（时间窗: ${SINCE}，级别≥${LEVEL}）"
fi
