# Changelog

## 0.2.0

- **Writes, locked by default:** an `INSERT`, `UPDATE` or `DELETE` opens a prompt with the exact statement. It shows ASCII only, is paged to the pane, and warns when an `UPDATE` or `DELETE` has no `WHERE`. **Run this statement once** runs it in one transaction and shows the affected rows. **Unlock for this session** isn't offered for production, and the unlock is tied to the server entry. 🔒 / 🔓 shows and resets the lock. DDL, privileges, `LOAD`, `OUTFILE`, `CALL`, locks and multiple statements stay refused.
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
