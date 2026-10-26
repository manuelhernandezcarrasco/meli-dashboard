#!/usr/bin/env bash
# Usage: scripts/create-db.sh <name>   -> creates the database and applies migrations
set -euo pipefail
name="${1:?usage: create-db.sh <database name>}"
docker compose exec -T db psql -U pnl -d pnl -c "CREATE DATABASE \"$name\"" 2>&1 | grep -v "already exists" || true
DATABASE_URL="postgresql://pnl:pnl@localhost:5432/$name" pnpm prisma migrate deploy
echo "Set DATABASE_URL=postgresql://pnl:pnl@localhost:5432/$name in this worktree's .env"
