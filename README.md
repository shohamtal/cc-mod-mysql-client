# SQL Console: a Claude Code mod

A **read-only** MySQL console docked beside the Claude Code terminal. Claude writes queries into it, you check and run them, and Claude reads the result.

- **Editor:** SQL colors, a ▶ next to every statement, and autocomplete for keywords, databases, tables (after `FROM`/`JOIN`, `db.`) and columns (in `SELECT`/`WHERE`/`ON`/`BY`, `alias.`). Also selection, copy / cut / paste, undo / redo and keyword formatting.
- **Result:** a table you scroll in both directions. Open a row to see it as `column: value` lines. Find highlights matches; copy as TSV or JSON.
- **Servers and databases:** any number of servers in a **▾ menu**, each with its own databases, tagged production / staging / development / local (production is red). Passwords come from the file, an environment variable or a command.
- **Separate consoles:** each session or agent gets its own console file (`/sql --filepath x.json --configfilepath y.json`), and the `mcp__sql-console__console` tool tells the model how to use it.

## Install

```
claude plugin marketplace add shohamtal/cc-mod-sql-console
claude plugin install sql-console@cc-mod-sql-console --scope user
```

Then type `/sql` to toggle the pane.

## Read-only, enforced in code

Even when the database user could write, the console sends only one read statement at a time:

1. **The statement guard** (`readGuard` in `hooks/lib.ts`):
   - Only `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `TABLE` or `VALUES`, one statement at a time.
   - It is checked with strings and comments removed, so a write can't hide inside them.
   - It refuses:
     - writes, DDL and privilege changes
     - locks (`FOR UPDATE`, `LOCK`, `GET_LOCK`), `SET`, and transaction commands
     - `INTO OUTFILE`, `INTO @var`, `LOAD_FILE`
     - `/*! … */` comments, which MySQL runs as code
     - mysql client commands (`\!`, `system`, `source`, …)
2. **The server enforces it too:** each statement runs as `SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY; … ; ROLLBACK`, with `sql_select_limit` and `max_execution_time` set. So even a statement the guard missed can't write.
3. **The client:**
   - `mysql` runs with `--skip-system-command`, and with `--defaults-file` set to the mod's own option file, so `~/.my.cnf` and `/etc/my.cnf` are never read. A pager, tee file or init command planted there has no effect.
   - The password goes through that option file, read from a process substitution, never on the command line or on disk.
   - The session's `sql_mode` drops `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES`, so the server reads strings the way the guard does.

**Credentials ask first.** A server with a user asks once before its first query or schema load: *"Connect to <server> with these credentials? db.example.com:3306 gets user reader, password from $DB_PW"*. It asks again whenever its host or credential source changes in the config, so an edited config can't send your password somewhere new. A `passwordCommand` never runs before you allow it.

**Recommended:** a deny rule in `~/.claude/settings.json` makes Claude Code refuse edits to the console's config through its file tools. Shell commands aren't covered, so keep Bash on approval:

```json
{ "permissions": { "deny": ["Edit(~/.claude/mods/sql/servers.json)", "Edit(~/.claude/plugins/store/**)", "Edit(~/.my.cnf)"] } }
```

Use a read-only database user anyway.

## Configure

`~/.claude/mods/sql/servers.json` is created on first use with one `localhost` example. Add as many servers as you like; the pane lists them in its **▾ server** menu, and each server's databases in the **▾ database** menu:

```json
{ "servers": [
  { "id": "local", "name": "Local", "host": "localhost", "tag": "local", "username": "root", "passwordEnv": "MYSQL_LOCAL_PW" },
  { "id": "prod", "name": "Production (replica)", "host": "db-ro.example.com", "port": 3306, "https": true, "tag": "production",
    "username": "reader", "passwordCommand": ["security", "find-generic-password", "-s", "db-prod", "-w"], "databases": ["app", "billing"] }
] }
```

| Field | Meaning |
|---|---|
| `id` / `name` | Stable key (stored in session files) / what the menu shows |
| `host`, `port`, `https` | Where to connect; port defaults to 3306, `https: true` requires TLS |
| `username` + one of `password`, `passwordEnv`, `passwordCommand` | The password from the file, an environment variable, or a command's output (Keychain, 1Password, `pass`) |
| `tag` | `production`, `staging`, `development` or `local`; production is shown in red |
| `databases` | The database menu; leave it empty to list them with `SHOW DATABASES` |
| `maxRows`, `timeoutSec`, `mysqlPath` | Row cap (1000), SELECT time cap (60 s), path to the `mysql` client |

You need the `mysql` client (`brew install mysql-client` on macOS, `apt install mysql-client` on Debian/Ubuntu).

## Files

| File | Holds |
|---|---|
| `~/.claude/mods/sql/sessions/<name>.json` | `{ server, database, cursorRow, query, lastRun }` |
| `~/.claude/mods/sql/sessions/<name>.result.json` | `{ columns, rows, rowCount, limited, ms, error?, sql, at }` |
| `~/.claude/mods/sql/schema.json` | table and column names for autocomplete, per server |

## Develop

```bash
claude plugin validate . && claude plugin test .
```
