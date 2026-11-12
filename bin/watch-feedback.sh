#!/usr/bin/env bash
set -u
repo="${1:?usage: watch-feedback.sh owner/repo [interval-seconds]}"
interval="${2:-30}"
label="${FEEDBACK_LABEL:-feedback}"
filter='
.[] | select(.pull_request | not)
| (.body // "") as $b
| [.labels[].name] as $l
| .author_association as $a
| select(($l | index($label)) or ($b | test("<!--\\s*feedback-meta")))
| (try ($b | capture("<!--\\s*feedback-meta\\s+(?<m>\\{.*?\\})\\s*-->").m | fromjson) catch {}) as $m
| ([$l[] | select(startswith("branch:")) | sub("^branch:"; "")] | first // $m.branch // "?") as $br
| (if ((["OWNER","MEMBER","COLLABORATOR"] | index($a)) or ($l | index($label))) then "FEEDBACK" else "UNTRUSTED (needs the \($label) label from a maintainer)" end) as $t
| "\(.number)\t\($t) #\(.number) branch=\($br) app=\($m.app // "-") page=\($m.page // "?") by @\(.user.login) [\(.author_association)]: \(.title) \(.html_url)"'
seen=" "
last_error=""
while true; do
  if out=$(gh api "repos/$repo/issues?state=open&per_page=100&sort=created&direction=desc" | jq -r --arg label "$label" "$filter" 2>&1); then
    last_error=""
    while IFS=$'\t' read -r num line; do
      [ -z "$num" ] && continue
      case "$seen" in *" $num "*) continue ;; esac
      seen="$seen$num "
      echo "$line"
    done <<<"$out"
  else
    err=$(echo "$out" | head -n 1)
    [ "$err" != "$last_error" ] && echo "WATCHER ERROR: $err"
    last_error="$err"
  fi
  sleep "$interval"
done
