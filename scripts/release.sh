#!/usr/bin/env bash
# 把版本号写进 app/mygo.config.ts，并打印一条发版命令。
# 用法：scripts/release.sh <版本号>
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

usage() {
  echo "用法：scripts/release.sh <版本号>，例如 0.2.2" >&2
}

version="${1:-}"
if [ -z "$version" ]; then
  usage
  exit 1
fi
version="${version#v}"
tag="v$version"

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "版本号格式不对：${version}" >&2
  usage
  exit 1
fi

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "当前不在 main 上，先切回 main。" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "本地已有 tag ${tag}，换个版本号。" >&2
  exit 1
fi

perl -pi -e "s/version: \"[^\"]*\"/version: \"$version\"/" app/mygo.config.ts

configured=$(sed -n 's/.*version: *"\([^"]*\)".*/\1/p' app/mygo.config.ts | head -1)
if [ "$configured" != "$version" ]; then
  echo "写入失败：app/mygo.config.ts 里是 ${configured}" >&2
  exit 1
fi

cat <<EOF
版本号已改为 ${version}。执行这一条完成提交、打 tag 和推送：

  git add app/mygo.config.ts && git commit -m "chore: 版本号升到 ${version}" && git tag -a ${tag} -m "version ${version}" && git push --follow-tags
EOF
