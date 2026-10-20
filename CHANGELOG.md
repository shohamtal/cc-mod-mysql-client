# Changelog

## 0.2.1

- **Renamed** to `mysql-client` (repo `cc-mod-mysql-client`), so people looking for a MySQL client, SQL client or SQL editor find it. `/sql` is unchanged. The agent tool is now `mcp__mysql-client__console`, and the credentials you allowed are asked for once more.
- **Tool description fits:** Claude Code passes the model only the first 2048 characters, which cut off the write rules. They now come first, and a test keeps the description under the limit.
- **Screenshots and a demo database** (`demo/`).

## 0.2.0

- **Writes, locked by default:** any data, schema, privilege or `CALL` statement opens a prompt with the exact statement. It shows ASCII only, is paged to the pane, warns on a missing `WHERE` and on non-undoable DDL, and names non-built-in function calls. **Run this statement once** or **Unlock for this session** (never on production, tied to the server entry). 🔒 / 🔓 shows the lock. DDL covers tables, indexes, views, databases, users and roles. Files, session or server control, server objects, `SONAME`, creating routines, triggers or events, `DEFINER`, system schemas and multiple statements stay refused.
- **Credentials:** a server with credentials asks once before first use.
- **Client options:** `mysql` reads only the mod's own option file.
- **Agent tool:** it stays inside the mod's folder.
- **Windows:** the mod falls back to `USERPROFILE` when `HOME` is not set.

## 0.1.0

First release: a read-only MySQL console pane for Claude Code.

- **Editor:** SQL colors, a ▶ next to every statement, and schema-aware autocomplete for keywords, databases, tables and columns. Also undo / redo and copy / cut / paste.
- **Result:** a table you scroll in both directions, with expandable rows, find, and copy as TSV or JSON.
- **Servers and databases:** any number of servers in a ▾ menu, each with a ▾ database menu. Passwords come from the file, an environment variable or a command.
- **Read-only, three ways:** a statement guard, a read-only session and transaction, and `--skip-system-command`.
