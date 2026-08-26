---
name: install-local-revoir
description: Build and replace the currently running Revoir installation on this Mac from a clean repository checkout, then restart and verify the launchd service. Use only when the user asks to install or upgrade this machine's local Revoir daemon.
---

# Install Local Revoir

Require explicit authorization to replace the executable and restart the live daemon. Preserve the existing configuration, credentials, and XDG data.

1. Confirm the checkout is on the requested commit and clean. Do not stash or discard changes to satisfy the release build.
2. Record `~/.local/bin/revoir status`, then build with:

   ```bash
   mise exec -- pnpm --filter cli release:macos
   ```

3. Verify the metadata path printed by the release command names the checkout's `git rev-parse HEAD`, then atomically replace the executable:

   ```bash
   mise exec -- pnpm --filter cli release:macos:install
   ```

4. Restart the existing service with `~/.local/bin/revoir stop` followed by `~/.local/bin/revoir start`. Do not rerun setup or rewrite configuration.
5. Require both `~/.local/bin/revoir diagnose` and `~/.local/bin/revoir status` to pass. Report the installed commit and healthy PID.

Stop on the first build or install failure. If restart or health verification fails, inspect `~/.local/bin/revoir logs` and report the failure without changing configuration or credentials.
