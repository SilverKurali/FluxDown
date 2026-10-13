#!/usr/bin/env bash
# PR review worktree 助手。从仓库任意位置（含 PR worktree 内）调用均可。
#   pr.sh info    <N>              PR 元数据 + CI 摘要 + 推送权限
#   pr.sh setup   <N>              拉取到 .worktrees/pr-<N>（已存在则快进到 PR 最新头）
#   pr.sh push    <N> [--dry-run]  把 worktree HEAD 快进推回 PR head 分支（禁 force）
#   pr.sh cleanup <N> [--force]    删除 worktree、本地分支与 PR 引用
set -euo pipefail

usage() { echo "用法: pr.sh <info|setup|push|cleanup> <PR号> [--dry-run|--force]" >&2; exit 2; }
cmd=${1:-}; n=${2:-}; opt=${3:-}
[[ -n "$cmd" && "$n" =~ ^[0-9]+$ ]] || usage

root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
cd "$root"
wt="$root/.worktrees/pr-$n"
br="pr-$n"
ref="refs/remotes/origin/pr/$n"

case "$cmd" in
info)
  gh pr view "$n" --json number,title,author,state,isDraft,baseRefName,headRefName,headRefOid,headRepositoryOwner,headRepository,isCrossRepository,maintainerCanModify,mergeable,mergeStateStatus,additions,deletions,changedFiles,statusCheckRollup \
    --jq '{number, title, author: .author.login, state, isDraft, base: .baseRefName,
           head: "\(.headRepositoryOwner.login)/\(.headRepository.name):\(.headRefName)", headOid: .headRefOid[0:10],
           cross: .isCrossRepository, maintainerCanModify, mergeable, mergeStateStatus,
           size: "+\(.additions) -\(.deletions) / \(.changedFiles) files",
           checks: [.statusCheckRollup[] | "\(.name)=\(.conclusion // .status)"]}'
  ;;
setup)
  git fetch --quiet origin main "+pull/$n/head:$ref"
  if [[ -d "$wt" ]]; then
    [[ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ]] || { echo "worktree 有未提交改动，先处理: $wt" >&2; exit 1; }
    git -C "$wt" merge --ff-only --quiet "$ref" || { echo "PR 头无法快进到本地分支（本地有未推送提交或作者 force-push），人工处理" >&2; exit 1; }
    echo "已刷新: $wt"
  else
    git worktree add --quiet -B "$br" "$wt" "$ref"
    echo "已创建: $wt"
  fi
  echo "HEAD: $(git -C "$wt" log -1 --format='%h %s')"
  base=$(git -C "$wt" merge-base origin/main HEAD)
  echo "落后 main: $(git -C "$wt" rev-list --count HEAD..origin/main) 个提交；PR 自有提交: $(git -C "$wt" rev-list --count origin/main..HEAD)"
  if conflicts=$(git -C "$wt" merge-tree --write-tree --name-only origin/main HEAD); then
    echo "与 origin/main 合并: 无冲突"
  else
    echo "与 origin/main 合并: 有冲突 →"; printf '%s\n' "$conflicts" | sed -n '2,$p' | sed '/^$/,$d'
  fi
  echo "--- 改动（相对 merge-base $(git rev-parse --short "$base")）---"
  git -C "$wt" diff --stat "$base" HEAD
  ;;
push)
  [[ -d "$wt" ]] || { echo "worktree 不存在: $wt" >&2; exit 1; }
  [[ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ]] || { echo "worktree 有未提交改动" >&2; exit 1; }
  read -r cross can owner repo head oid < <(gh pr view "$n" \
    --json isCrossRepository,maintainerCanModify,headRepositoryOwner,headRepository,headRefName,headRefOid \
    --jq '"\(.isCrossRepository) \(.maintainerCanModify) \(.headRepositoryOwner.login) \(.headRepository.name) \(.headRefName) \(.headRefOid)"')
  if [[ "$cross" == true && "$can" != true ]]; then
    echo "NO_PUSH: 作者未开启 Allow edits from maintainers，改为在 PR 评论附补丁" >&2; exit 3
  fi
  git -C "$wt" merge-base --is-ancestor "$oid" HEAD || { echo "远端 PR 头 ${oid:0:10} 不在本地历史中（作者刚推过），先 setup 刷新再推" >&2; exit 1; }
  if [[ "$cross" == true ]]; then url="git@github.com:$owner/$repo.git"; else url=origin; fi
  dry=(); [[ "$opt" == --dry-run ]] && dry=(--dry-run)
  git -C "$wt" push ${dry[@]+"${dry[@]}"} "$url" "HEAD:refs/heads/$head" || { echo "NO_PUSH: 推送被拒，改为在 PR 评论附补丁" >&2; exit 3; }
  ;;
cleanup)
  if [[ -d "$wt" ]]; then
    if [[ "$opt" == --force ]]; then git worktree remove --force "$wt"; else git worktree remove "$wt"; fi
  fi
  git worktree prune
  if git show-ref --verify --quiet "refs/heads/$br"; then git branch -D --quiet "$br"; fi
  if git show-ref --verify --quiet "$ref"; then git update-ref -d "$ref"; fi
  echo "已清理 PR #$n"
  ;;
*) usage ;;
esac
