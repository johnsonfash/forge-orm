# 07 · Bun + SQLite

Bun's built-in SQLite. Zero deps beyond `forge-orm`.

## Run it

Bun's SQLite uses native bindings, needs a real OS — not StackBlitz. `.codesandbox/tasks.json` auto-installs Bun + auto-runs:

- **[Run on CodeSandbox](https://codesandbox.io/p/devbox/github/johnsonfash/forge-orm-examples/main/07-bun-cli-needs-vm)**

Or locally (fastest):

```sh
curl -fsSL https://bun.sh/install | bash
npx degit johnsonfash/forge-orm-examples/07-bun-cli-needs-vm my-demo
cd my-demo && bun install && bun run dev
```

## Why Bun's SQLite?

Bun ships SQLite as a built-in — zero deps, faster cold-start than better-sqlite3. forge-orm auto-detects the Bun runtime and uses `bun:sqlite` directly.
