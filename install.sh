#!/bin/bash
# 会社PCに CLAUDE.md と 2 つの mod（status-band・cockpit）を入れるスクリプト
# 使い方: bash install.sh   （このフォルダの中で実行する）
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
MODS_DIR="$HOME/mods"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$CLAUDE_DIR" "$MODS_DIR"

# 1) CLAUDE.md（既にあれば退避してから置く）
if [ -f "$CLAUDE_DIR/CLAUDE.md" ]; then
  cp "$CLAUDE_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md.bak-$STAMP"
  echo "既存の CLAUDE.md を CLAUDE.md.bak-$STAMP に退避しました"
fi
cp "$KIT/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
echo "CLAUDE.md を置きました"

# 2) mod（既にあれば退避してから置く）
for m in status-band cockpit; do
  if [ -e "$MODS_DIR/$m" ]; then
    mv "$MODS_DIR/$m" "$MODS_DIR/$m.bak-$STAMP"
    echo "既存の $m を $m.bak-$STAMP に退避しました"
  fi
  cp -R "$KIT/mods/$m" "$MODS_DIR/$m"
done
echo "mod を $MODS_DIR に置きました"

# 3) settings.json の env.CLAUDE_CODE_PLUGIN_DIRS に mod の場所を足す（他の設定はそのまま残す）
SETTINGS="$CLAUDE_DIR/settings.json"
DIRS="$MODS_DIR/status-band:$MODS_DIR/cockpit"
[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak-$STAMP"

if command -v python3 >/dev/null 2>&1; then
  python3 -I - "$SETTINGS" "$DIRS" <<'PY'
import json, os, sys
path, dirs = sys.argv[1], sys.argv[2]
d = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) > 0 else {}
env = d.setdefault("env", {})
cur = [p for p in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":") if p]
for p in dirs.split(":"):
    if p not in cur:
        cur.append(p)
env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(cur)
json.dump(d, open(path, "w"), ensure_ascii=False, indent=2)
PY
elif command -v node >/dev/null 2>&1; then
  node - "$SETTINGS" "$DIRS" <<'JS'
const fs = require('fs'); const [path, dirs] = process.argv.slice(2);
const d = fs.existsSync(path) && fs.statSync(path).size ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
d.env = d.env || {};
const cur = (d.env.CLAUDE_CODE_PLUGIN_DIRS || '').split(':').filter(Boolean);
for (const p of dirs.split(':')) if (!cur.includes(p)) cur.push(p);
d.env.CLAUDE_CODE_PLUGIN_DIRS = cur.join(':');
fs.writeFileSync(path, JSON.stringify(d, null, 2));
JS
else
  echo "python3 も node も見つかりませんでした。$SETTINGS に次の内容を手で足してください："
  echo "  \"env\": { \"CLAUDE_CODE_PLUGIN_DIRS\": \"$DIRS\" }"
  exit 1
fi
echo "settings.json に mod の場所を登録しました：$DIRS"
echo "完了しました。Claude Code を起動し直してください。"
