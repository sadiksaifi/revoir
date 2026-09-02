This project is just for my personal and my org some repo personal use only.

## Secret-handling requirements

- Never print, dump, or include the contents of Revoir configuration or credential files in command output, logs, chat responses, or bug reports. This includes `~/.config/revoir/config.json` and any file containing GitHub App private keys, webhook secrets, Cloudflare API tokens, OAuth tokens, or credentials.
- Do not assume checking only top-level field names is sufficient. Secrets may be nested. When inspecting configuration, use an explicit allowlist of known-safe fields and print only those fields individually.
- Prefer built-in redacted commands such as `revoir diagnose --json`, `revoir status`, and `revoir repository list` over custom scripts that read credential files.
- If credentials must be read for an authenticated diagnostic, keep them entirely in-process and output only non-sensitive, explicitly selected results. Never serialize the source configuration object.
- Before running any diagnostic command, inspect it for accidental output paths such as broad object iteration, `cat`, unfiltered JSON formatting, shell tracing, or error messages that could echo request headers or credentials.
- If a secret is exposed, stop further exposure, tell the user exactly which credential classes were affected, and recommend immediate rotation without repeating any secret value.
