# script/

Lifecycle scripts following the
[OHF task conventions](https://standards.openhomefoundation.org/standards/task-conventions/).
Each is invokable directly or through its mise task; prefer the mise task, which
also provisions the pinned Node version.

| Script           | Task              | Purpose                                                     |
| ---------------- | ----------------- | ----------------------------------------------------------- |
| `script/setup`   | `mise run setup`  | First-time setup: install dependencies, create `.env`       |
| `script/update`  | `mise run update` | Sync after pulling: reinstall dependencies, flag new config |
| `script/server`  | `mise run dev`    | Start the development server in watch mode                  |
| `script/test`    | `mise run test`   | Unit tests, then end-to-end tests                           |
| `script/cibuild` | `mise run ci`     | Format check, lint, typecheck, tests, build                 |

All scripts are bash, idempotent, and resolve the repository root themselves, so
they work from any directory.

This project has no database and no code generation, so `setup` and `update`
have no migration or codegen steps. Configuration is entirely environment
variables: `setup` copies `example.env` to `.env` only when `.env` is absent and
never reads or overwrites an existing one.
