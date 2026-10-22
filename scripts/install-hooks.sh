#!/bin/bash
# Point git at the repo's hooks. Run once per clone.
set -e
cd "$(git rev-parse --show-toplevel)"
chmod +x scripts/hooks/pre-commit
git config core.hooksPath scripts/hooks
echo "hooks installed: core.hooksPath=scripts/hooks"
