# Changelog

## 0.1.0

First release: a read-only MySQL console pane for Claude Code.

- **Editor:** SQL colors, a ▶ next to every statement, and schema-aware autocomplete for keywords, databases, tables and columns. Also undo / redo and copy / cut / paste.
- **Result:** a table you scroll in both directions, with expandable rows, find, and copy as TSV or JSON.
- **Servers and databases:** any number of servers in a ▾ menu, each with a ▾ database menu. Passwords come from the file, an environment variable or a command.
- **Read-only, three ways:** a statement guard, a read-only session and transaction, and `--skip-system-command`.
