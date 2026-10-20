# Security

## What this plugin touches

- **Network:** only the MySQL servers in your config file, through the `mysql` client. Nothing else is contacted.
- **Credentials:**
  - **Sources:** the config file, an environment variable (`passwordEnv`, read with `printenv`), or a command you configure (`passwordCommand`).
  - **Delivery:** the password reaches `mysql` through an option file read from a process substitution, never on the command line or on disk.
  - **Exposure:** it is never logged, never shown in the pane, and never sent to the model. The agent-facing docs tell Claude not to print it.
- **Files:** reads and writes only under `~/.claude/mods/sql/` plus the session/config paths you pass explicitly.
- **Processes:**
  - `bash` and `mysql` for queries
  - the first clipboard reader that works for `ctrl+v` (`pbpaste`, `wl-paste`, `xclip`, `powershell.exe`)
  - `printenv` and your `passwordCommand` when configured
- **Writes to the database:** locked by default, enforced in code whatever the database user may do.
  1. **Reads:** `readGuard` in `hooks/lib.ts` allows one `SELECT` / `WITH` / `SHOW` / `DESCRIBE` / `EXPLAIN` / `TABLE` / `VALUES` statement at a time, checked with strings and comments removed. It runs inside `SET SESSION TRANSACTION READ ONLY` and `START TRANSACTION READ ONLY … ROLLBACK`.
  2. **Writes:** `classifyStatement` allows one data, schema, privilege or `CALL` statement. It runs only after the person approves the exact statement in the pane (once, or for the session on a server not tagged production; unlocks are in memory only). Data changes run in one transaction; DDL commits at once, and the prompt says so.
  3. **Always refused:**
     - files (`LOAD`, `INTO OUTFILE` / `DUMPFILE`, `LOAD_FILE`)
     - session and server control (`SET`, transactions, locks, `KILL`, `SHUTDOWN`, plugins)
     - server objects (`INSTANCE`, tablespaces, resource groups, `SERVER`), `SONAME`, `DATA` / `INDEX DIRECTORY`, `CONNECTION`
     - creating or altering procedures, functions, triggers and events; `DEFINER = …`
     - system schemas, `/*! */`, optimizer hints in writes, multiple statements, mysql client commands
  4. **Client:** `mysql` runs with `--skip-system-command` and `--defaults-file` (its own option file only, never `~/.my.cnf`). The session `sql_mode` drops `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES`.
- **Credentials ask first:** a server with a user needs the person's OK once before its first query, keyed to its host and credential source; a `passwordCommand` never runs before that.

Use a database user with only the rights you need.

## Hardening

Deny edits to `~/.claude/mods/sql/*.json`, `~/.claude/plugins/store/**` and `~/.my.cnf` in your Claude Code permissions (the README shows the rule). That covers Claude Code's file tools; shell commands need Bash kept on approval.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
