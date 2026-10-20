# Contributing

Thanks for helping! Issues and pull requests are welcome.

## Before you start

- **Bugs:** open an issue with the Claude Code version (`claude --version`), your OS and terminal, what you did, what you expected and what happened.
- **Features:** open an issue first if the change is large, so we can agree on the shape before you build it.
- **Security problems:** don't open a public issue; see [SECURITY.md](SECURITY.md).

## Develop

1. Fork the repo and clone your fork.
2. Load your copy: `claude --plugin-dir ./cc-mod-mysql-client`, then type `/sql`. Saving a file hot-reloads the mod.
3. Before you open a PR, run both and make sure they pass:
   ```bash
   claude plugin validate .
   claude plugin test .
   ```
4. Add or update tests in `hooks/*.test.ts` for every behaviour you change.

## Pull requests

- One topic per PR, with a clear description: what, why, how you tested it, and a screenshot for UI changes.
- Don't weaken the safety rules without discussing it in an issue first: the read-only or write-lock guard, credentials staying off the command line and out of logs.
- Use made-up data in screenshots and tests, never real hosts, credentials or customer data.
- Every PR gets a security review before it's merged.

By contributing you agree that your work is released under the [MIT License](LICENSE).
