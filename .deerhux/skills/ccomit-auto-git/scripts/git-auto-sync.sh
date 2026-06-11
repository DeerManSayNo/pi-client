#!/bin/bash
# git-auto-sync.sh — Fully automated git sync: pull → resolve conflicts → push
# Usage: ./git-auto-sync.sh [strategy] [commit message]
#   strategy: theirs (default, remote wins) | ours (local wins) | union (keep both)
#   commit message: auto commit message (default: "auto: sync")
set -euo pipefail

STRATEGY="${1:-theirs}"
COMMIT_MSG="${2:-auto: sync}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()    { echo -e "${GREEN}[auto-sync]${NC} $1"; }
warn()   { echo -e "${YELLOW}[auto-sync]${NC} $1"; }
err()    { echo -e "${RED}[auto-sync]${NC} $1"; }

# ── Pre-flight checks ──────────────────────────────────────────
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    err "当前目录不是 git 仓库"
    exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
REMOTE=$(git remote | head -1)

if [ -z "$REMOTE" ]; then
    err "没有配置 remote，无法同步"
    exit 1
fi

if [ "$BRANCH" = "HEAD" ]; then
    err "处于 detached HEAD 状态，请先切换到分支"
    exit 1
fi

log "分支: $BRANCH | 远程: $REMOTE | 策略: $STRATEGY"
echo ""

# ── Step 1: Stash 未提交的改动 ─────────────────────────────────
STASHED=false
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    warn "检测到未提交的改动，先 stash..."
    git stash push -m "git-auto-sync: auto stash before sync" || {
        err "Stash 失败，请手动处理"
        exit 1
    }
    STASHED=true
    log "✅ 已 stash"
fi

# ── Step 2: Fetch 最新代码 ─────────────────────────────────────
log "正在 fetch $REMOTE/$BRANCH ..."
if ! git fetch "$REMOTE" "$BRANCH" 2>&1; then
    err "Fetch 失败"
    [ "$STASHED" = true ] && git stash pop 2>/dev/null || true
    exit 1
fi

# 检查是否有新内容需要同步
LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null || echo "")

if [ "$LOCAL_HASH" = "$REMOTE_HASH" ] && [ "$STASHED" = false ]; then
    log "🎉 已经是最新，无需同步"
    exit 0
fi

# ── Step 3: Rebase + 自动解决冲突 ─────────────────────────────
log "正在 rebase 到 $REMOTE/$BRANCH (策略: -X $STRATEGY) ..."
REBASE_OK=true
if ! git rebase "$REMOTE/$BRANCH" -X "$STRATEGY" 2>&1; then
    REBASE_OK=false
    warn "-X $STRATEGY 无法完全自动解决，正在逐文件强制处理..."

    # 逐文件解决剩余冲突
    CONFLICT_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null || echo "")
    if [ -n "$CONFLICT_FILES" ]; then
        while IFS= read -r file; do
            [ -z "$file" ] && continue
            warn "  → 处理冲突文件: $file"
            case "$STRATEGY" in
                theirs)
                    git checkout --theirs -- "$file" 2>/dev/null || git show ":$REMOTE/$BRANCH:$file" > "$file" 2>/dev/null || true
                    ;;
                ours)
                    git checkout --ours -- "$file" 2>/dev/null || true
                    ;;
                union)
                    git merge-file --union "$file" "$(git show :2:"$file" 2>/dev/null || echo /dev/null)" "$(git show :3:"$file" 2>/dev/null || echo /dev/null)" 2>/dev/null || {
                        git checkout --theirs -- "$file" 2>/dev/null || true
                    }
                    ;;
            esac
            git add "$file" 2>/dev/null || true
        done <<< "$CONFLICT_FILES"
    fi

    # 继续 rebase
    GIT_EDITOR=true git rebase --continue 2>/dev/null || {
        # 如果 rebase --continue 还是失败，尝试 abort 后用 merge
        warn "Rebase 无法继续，切换到 merge 策略..."
        git rebase --abort 2>/dev/null || true
        git merge "$REMOTE/$BRANCH" -X "$STRATEGY" --no-edit 2>/dev/null || {
            # merge 也失败了，强制按策略处理
            CONFLICT_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null || echo "")
            if [ -n "$CONFLICT_FILES" ]; then
                while IFS= read -r file; do
                    [ -z "$file" ] && continue
                    case "$STRATEGY" in
                        theirs) git checkout --theirs -- "$file" 2>/dev/null || true ;;
                        ours)   git checkout --ours -- "$file" 2>/dev/null || true ;;
                    esac
                    git add "$file" 2>/dev/null || true
                done <<< "$CONFLICT_FILES"
                git commit --no-edit 2>/dev/null || git commit -m "$COMMIT_MSG" 2>/dev/null || true
            fi
        }
    }
    log "✅ 冲突已解决"
else
    log "✅ Rebase 成功（无冲突或自动解决）"
fi

# ── Step 4: 恢复 stash ─────────────────────────────────────────
if [ "$STASHED" = true ]; then
    log "正在恢复 stash 的改动..."
    if git stash pop 2>&1; then
        log "✅ Stash 已恢复"
    else
        warn "Stash pop 有冲突，使用 $STRATEGY 策略处理..."
        CONFLICT_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null || echo "")
        if [ -n "$CONFLICT_FILES" ]; then
            while IFS= read -r file; do
                [ -z "$file" ] && continue
                case "$STRATEGY" in
                    theirs) git checkout --theirs -- "$file" 2>/dev/null || true ;;
                    ours)   git checkout --ours -- "$file" 2>/dev/null || true ;;
                esac
                git add "$file" 2>/dev/null || true
            done <<< "$CONFLICT_FILES"
        fi
        warn "⚠️  Stash 冲突已强制处理，请 review 改动"
    fi
fi

# ── Step 5: 如果有改动，自动提交 ────────────────────────────────
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    log "正在提交: $COMMIT_MSG"
    git add -A
    git commit -m "$COMMIT_MSG" || log "没有需要提交的内容"
fi

# ── Step 6: Push ───────────────────────────────────────────────
log "正在推送到 $REMOTE/$BRANCH ..."
if git push "$REMOTE" "$BRANCH" 2>&1; then
    log "✅ 推送成功!"
else
    warn "普通 push 被拒绝，尝试 --force-with-lease ..."
    if git push --force-with-lease "$REMOTE" "$BRANCH" 2>&1; then
        log "✅ --force-with-lease 推送成功!"
    else
        err "推送失败，请手动检查"
        exit 1
    fi
fi

echo ""
log "🎉 完成! $BRANCH 已同步到 $REMOTE"
