# Setting up jordag (for AI agents)

Follow these steps in order to install jordag for a user and prove it works. Every command is non-interactive. Run them from the repo root unless a step says otherwise.

## 1. Check prerequisites

```bash
python3 --version   # 3.9 or newer
git --version
node --version      # 18 or newer (needed for `jordag query` and the skills)
```

If `node` is missing, the viewer still works but the skills won't. Tell the user.

## 2. Install

```bash
python3 jordag.py setup
```

This links `~/.local/bin/jordag` and `~/.claude/skills/jordag*`.
- To install somewhere else, pass `--bin <dir>` or `--skills <dir>`.
- If it reports `skipped ... already exists`, a different copy is installed there. Ask the user before replacing it.
- If `~/.local/bin` isn't on `PATH`, use `python3 <repo>/jordag.py` wherever these steps say `jordag`, and tell the user to add it to `PATH`.

If the user already runs a jordag server on the default port, set `JORDAG_PORT` (e.g. `8799`) for the steps below so you don't talk to their running copy. The query output's `url:` always shows which server answered.

## 3. Verify with the demo project

```bash
python3 -m venv demo/.venv
demo/.venv/bin/pip install dbt-duckdb sqlglot
node test.mjs                                    # expect: "selector ok" and "usage ok"
cd demo
jordag query -s '+customers'                     # expect: 8 nodes (5 models, 3 sources)
jordag query --column customers.lifetime_value   # expect: 3 upstream, ending at shop.raw_payments.amount
jordag query -s orders --usage                   # expect: "Usage reads Snowflake ACCESS_HISTORY; this project uses duckdb."
```

The first `--column` run compiles the demo and traces every column, which takes a few seconds.

To see the UI, run `jordag` (it opens the browser), or `jordag --print` to get the URL for an embedded browser.

## 4. Point it at the user's projects

From inside any of the user's dbt projects, run `jordag`. The project and all its git worktrees appear in the dropdown from then on. To also list projects that haven't been opened yet, add their parent folders to `roots` in `~/.config/jordag/config.json`.

jordag finds dbt in the project's `.venv` or `venv`, then in the main worktree's, then on `PATH`. Parse errors show in the UI's status pill.

## 5. Usage view (Snowflake only)

Ask the user for these, then write `~/.config/jordag/config.json` (see `config.example.json` and the README's configuration table):
- The production database and default schema.
- Whether prod uses bare custom schemas (`"custom"`) or dbt's default prefixing (`"prefixed"`).
- The Snowflake roles their BI tools use (consumers) and the roles people use (team).

Then run `jordag restart`, and from their project, `jordag query --usage`. The first run takes about a minute.

Their dbt role needs to be able to read `SNOWFLAKE.ACCOUNT_USAGE`. If it can't, the query output shows Snowflake's error; tell the user.

For Metabase dashboard names, the user sets `METABASE_API_KEY` in their shell and runs `jordag restart`. Don't ask them to give you the key.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `server failed to start` | See `~/.cache/jordag/server.log`. Usually the port is taken: set `JORDAG_PORT` |
| Red "parse error" pill | The project's own `dbt parse` fails. Click the pill for the output |
| Columns view: `No python with sqlglot` | `pip install sqlglot` into the project's dbt venv, or install `uv` |
| Changes to jordag's own code don't show | `jordag restart` |
