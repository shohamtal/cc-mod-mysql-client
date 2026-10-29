# Changelog

## 0.3.1

- **A new console under a symlinked folder in `sessions/` counts where the link points:** the agent tool resolves the nearest existing folder's real path, so a link can't carry a new file outside the mod's folder.
- **A saved console that can't be opened any more** (its name is now refused, or its config is gone) gives way to the default console when Claude Code starts, and a toast says why, instead of leaving the pane empty.

## 0.3.0

- **Running a statement never writes the session file.** The run is recorded only in `<name>.result.json`, which already held everything `lastRun` did. `lastRun` is gone from the session file. The session file is shared with the agent and other editors, and no write of the pane's could be made safe against a save landing after its last read, so a run no longer writes it at all. The session file is now written only for your own edits and menu picks. Reported in the catalogue review.
- A save drops the `lastRun` older versions left in the session file, and a console can't be named after another console's result file (`*.result.json`).

## 0.2.5

- **A save that someone else's save lands in the middle of no longer overwrites it:** the pane reads the session file again just before writing. If it changed, the pane merges again on top of the new version, and after three tries it gives up without writing and says the result or menu pick was not recorded. A toast that fails to show no longer stops later saves. An editor save that finds an outside change no longer writes at all. Claude Code has no atomic file write, so only a save landing in the instant between that last read and the write can still be lost. Reported in the catalogue review.

## 0.2.4

Fixes from an external review, each reproduced by a test that fails on 0.2.3:
- **A query still running when the console switches files** is recorded in its own console's result and session files, not the new one's.
- **Dragging the result pans at every step**, not only the first. A click survives a redraw between press and release.
- **ctrl+x copies the cut text**: the copy now travels on the cut's own edit post, since a second post in one frame replaced it.
- **Edits typed just before a console switch** are saved to the old console.
- **The pane's own save is never taken for an outside change**, so it no longer closes an open write prompt, and two saves no longer overlap.
- **An outside write in the same mtime tick** is noticed by its content.
- **A session file with a JSON typo is never overwritten.** The pane says it can't save until the file is fixed.
- **Smaller fixes:**
  - The wheel over the editor's bottom rows scrolls the editor while a menu is open.
  - A malformed result row no longer stops live updates.
  - Allow on a credentials prompt that was already cancelled does nothing.
  - Unlock re-checks whether the server became production since the prompt opened.

## 0.2.3

- **A finished query no longer overwrites a newer session file:** when the agent or another editor writes the session file while a query runs (or before a delayed editor save), the file's query, cursor, server and database are kept, only `lastRun` is added, and the pane reloads them. A server or database you pick from the menu still wins. A change is detected by modification time or by content, so two writes in one time tick count too. An outside write that lands within the 250 ms after your last keystroke wins over that keystroke. Reported in the catalogue review.

## 0.2.2

- **Copy works in every terminal:** copies go to `pbcopy` / `wl-copy` / `xclip` / `clip.exe` first, and the terminal's OSC 52 only as a fallback. OSC 52 is off by default in iTerm2 and missing in Terminal.app, where copying looked like it worked but left the clipboard empty.
- **A mouse selection copies itself:** Cmd+C belongs to the terminal and never reaches the pane, so selecting with the mouse copies, unless the selection looks like it holds a secret (`IDENTIFIED BY`, `PASSWORD`). `ctrl+c` still copies the selection, or the line.
- **Drag the result sideways** to scroll its columns. Claude Code doesn't pass a sideways trackpad swipe to mods; ← → still work.

## 0.2.1

- **Renamed** to `mysql-client` (repo `cc-mod-mysql-client`), so people looking for a MySQL client, SQL client or SQL editor find it. `/sql` is unchanged. The agent tool is now `mcp__mysql-client__console`, and the credentials you allowed are asked for once more. Servers remembered as production start fresh too: a server that is no longer tagged production can be unlocked for a session again.
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
