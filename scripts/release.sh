#!/usr/bin/env bash
# 本地发版：校验版本号、分支和 tag，通过后打印发版命令。
# 加 --push 时自己打 tag 并推送，触发 Release 工作流。
# 发版前先把 app/mygo.config.ts 的 version 改好，提交并推送到 main。
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

usage() {
  cat <<'EOF'
用法：scripts/release.sh [版本号] [--push] [--allow-dirty] [--dry-run]

  版本号          省略时用 app/mygo.config.ts 里的 version，例如 0.2.2
  --push          校验通过后打 tag 并推送 tag（默认只校验并打印命令）
  --allow-dirty   工作区有未提交改动时也继续（默认拒绝）
  --dry-run       只校验，不打印推送命令

发版前先把 app/mygo.config.ts 的 version 改好，提交并推送到 main。
EOF
}

version=""
push=0
allow_dirty=0
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --push) push=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "未知参数：$1" >&2; usage >&2; exit 1 ;;
    *)
      if [ -n "$version" ]; then
        echo "只能给一个版本号：已经给了 ${version}，又看到 $1" >&2
        exit 1
      fi
      version="$1"
      ;;
  esac
  shift
done

configured=$(sed -n 's/.*version: *"\([^"]*\)".*/\1/p' app/mygo.config.ts | head -1)
if [ -z "$configured" ]; then
  echo "读不到 app/mygo.config.ts 里的 version" >&2
  exit 1
fi

if [ -z "$version" ]; then
  version="$configured"
fi
version="${version#v}"

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "版本号格式不对：${version}（示例 0.2.2、0.3.0-rc.1）" >&2
  exit 1
fi

tag="v$version"

if [ "$configured" != "$version" ]; then
  echo "版本不一致：app/mygo.config.ts 是 ${configured}，要发的是 $tag" >&2
  echo "修复：把 app/mygo.config.ts 的 version 改成 ${version}，提交并推送 main 后再发版。" >&2
  exit 1
fi

head_version=$(git show HEAD:app/mygo.config.ts | sed -n 's/.*version: *"\([^"]*\)".*/\1/p' | head -1)
if [ "$head_version" != "$version" ]; then
  echo "app/mygo.config.ts 的版本改动还没提交（HEAD 里是 ${head_version}），先提交再发版。" >&2
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "当前分支是 ${branch}，发版要在 main 上。" >&2
  exit 1
fi

git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "本地 main 和 origin/main 不一致，先同步再发版。" >&2
  exit 1
fi

dirty=$(git status --porcelain)
if [ -n "$dirty" ]; then
  if [ "$allow_dirty" -eq 1 ]; then
    echo "注意：工作区有未提交改动，按 --allow-dirty 继续：" >&2
    printf '%s\n' "$dirty" >&2
  else
    echo "工作区有未提交改动，先提交，或加 --allow-dirty：" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
  fi
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "本地已有 tag ${tag}。换个版本号；确认要覆盖时手动 git tag -f。" >&2
  exit 1
fi

remote_tag=$(git ls-remote --tags origin "refs/tags/$tag") || {
  echo "查询远端 tag 失败，检查网络和远端配置。" >&2
  exit 1
}
if [ -n "$remote_tag" ]; then
  echo "远端已有 tag ${tag}，不能重复发布。" >&2
  exit 1
fi

if [ "$dry_run" -eq 1 ]; then
  echo "校验通过：可以发布 ${tag}。"
  exit 0
fi

if [ "$push" -eq 0 ]; then
  cat <<EOF
校验通过。确认后执行：

  git tag ${tag}
  git push origin ${tag}

或加 --push 让脚本完成这两步。
EOF
  exit 0
fi

git tag "$tag"
git push origin "$tag"

cat <<EOF

已推送 ${tag}，Release 工作流已触发。
看进度：gh run watch
看结果：gh run list --limit 1
EOF
