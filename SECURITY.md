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
- **Writes to the database:** none, enforced in code, whatever the database user may do:
  1. **Statement guard:** `readGuard` in `hooks/lib.ts` allows one `SELECT` / `WITH` / `SHOW` / `DESCRIBE` / `EXPLAIN` / `TABLE` / `VALUES` statement at a time. It checks the statement with strings and comments removed. It refuses:
     - writes, DDL, locks, `SET` and transaction commands
     - `INTO OUTFILE`
     - `/*! */` executable comments
     - mysql client commands
  2. **Read-only session:** every statement runs inside `SET SESSION TRANSACTION READ ONLY` and `START TRANSACTION READ ONLY … ROLLBACK`.
  3. **Client:** `mysql` runs with `--skip-system-command` and `--defaults-file` (its own option file only, never `~/.my.cnf`). The session `sql_mode` drops `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES`.
- **Credentials ask first:** a server with a user needs the person's OK once before its first query, keyed to its host and credential source; a `passwordCommand` never runs before that.

Use a read-only database user anyway.

## Hardening

Deny edits to `~/.claude/mods/sql/servers.json`, `~/.claude/plugins/store/**` and `~/.my.cnf` in your Claude Code permissions (the README shows the rule). That covers Claude Code's file tools; shell commands need Bash kept on approval.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
