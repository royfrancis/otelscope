#!/usr/bin/env bash
# Read-only. Checks that nothing in your logs was deleted, changed or cut short.
#
# Every log file in a backup (.jsonl or .pblog) must still be the exact beginning of the same file in the live log
# folder. The live file may only have grown. Run it after any step that touches the logs.
#
#   scripts/verify-logs-intact.sh BACKUP_DIR [LIVE_DIR]      (LIVE_DIR defaults to ~/otelscope)
#
# Exit status: 0 everything intact, 1 something is missing, shorter or different, 2 nothing to check.
set -euo pipefail

backup="${1:?usage: verify-logs-intact.sh BACKUP_DIR [LIVE_DIR]}"
live="${2:-$HOME/otelscope}"
backup="${backup%/}"
live="${live%/}"
[ -d "$backup" ] || { echo "backup folder not found: $backup"; exit 2; }
[ -d "$live" ] || { echo "log folder not found: $live"; exit 2; }

bytes() { wc -c < "$1" | tr -d ' '; }
checked=0
problems=0
while IFS= read -r -d '' file; do
  rel="${file#"$backup"/}"
  target="$live/$rel"
  checked=$((checked + 1))
  size="$(bytes "$file")"
  if [ ! -f "$target" ]; then
    echo "MISSING   $rel"
    problems=$((problems + 1))
    continue
  fi
  now="$(bytes "$target")"
  if [ "$now" -lt "$size" ]; then
    echo "SHORTER   $rel (the backup has $size bytes, the log now has $now)"
    problems=$((problems + 1))
  elif head -c "$size" "$target" | cmp -s - "$file"; then
    echo "intact    $rel ($size bytes in the backup, $((now - size)) added since)"
  else
    echo "CHANGED   $rel (the first $size bytes differ from the backup)"
    problems=$((problems + 1))
  fi
done < <(find "$backup" -type f \( -name '*.jsonl' -o -name '*.pblog' \) -print0 | sort -z)

if [ "$checked" -eq 0 ]; then
  echo "no .jsonl or .pblog files in $backup, so there is nothing to check"
  exit 2
fi
if [ "$problems" -gt 0 ]; then
  echo "NOT INTACT: $problems of $checked file(s) differ from the backup. Stop and look before going on."
  exit 1
fi
echo "All $checked file(s) intact."
