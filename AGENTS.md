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

This links `~/.local/bin/jordag` and `~/.claude/skills/jordag*`. Run `python3 jordag.py setup --help` for its options; pass `--bin <dir>` or `--skills <dir>` to install somewhere else.

`missing dbt` in setup's output is expected when dbt lives in project virtualenvs (the demo gets one in step 3).

**Make sure `jordag` means this checkout.** Run `readlink -f "$(command -v jordag)"`; it should end in this repo's `jordag.py`.
- If it doesn't, or setup printed `skipped` for the bin link (another copy is installed), or you used `--bin`, use `<bin>/jordag` or `python3 <repo>/jordag.py` wherever these steps say `jordag`.
- Ask the user before replacing another copy.
- If `~/.local/bin` isn't on `PATH`, tell the user to add it.

**Check whether another jordag server is running:** `curl -s 127.0.0.1:8765/api/ping`.
- A reply whose `home` isn't this repo (or has no `home`) is another copy.
- If so, pick a free port and prefix every command below with `JORDAG_PORT=<port> XDG_CACHE_HOME=<some dir>`. That gives this copy its own server and cache.
- Agent shells often don't keep `export`s between calls, so put the variables on each command.
- If another copy holds the port, jordag refuses to start (exit code 2) and says so. It never silently uses the other copy.
- Installed skills call whichever `jordag` is first on `PATH` with the default port. A side-by-side install is for testing from the shell; skills only use it if its bin dir comes first on `PATH` and `JORDAG_PORT` is set wherever the agent runs commands.

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

The first `--column` run compiles the demo and traces every column, which takes a few seconds. dbt-duckdb creates `demo/demo.duckdb` (gitignored) along the way.

Every successful `jordag query` prints a `url:` line near the top that opens the same view. The `--usage` check exits 1 with that message on non-Snowflake projects, which is expected for the demo.

To see the UI, run `jordag` (it opens the browser), or `jordag --print` to get the URL for an embedded browser.

When you're done testing, stop the server you started: `jordag stop` (with the same `JORDAG_PORT` if you set one).

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

## HTTP API

`jordag query` is the supported interface. For scripts, the server's JSON endpoints all take `p=<url-encoded project path>`:
- `/api/projects`
- `/api/graph?p=`
- `/api/node?p=&id=<unique_id>`
- `/api/usage?p=`
- `/api/columns?p=&id=<unique_id>[&col=<COLUMN>&dir=up|down|both]`

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `port … is served by another jordag` | Another copy, or an older version of this one, owns the port. Run `jordag restart` to replace it, or set `JORDAG_PORT` to run beside it |
| `server failed to start` | See `$XDG_CACHE_HOME/jordag/server.log` (default `~/.cache/jordag/server.log`). Usually the port is taken: set `JORDAG_PORT` |
| Red "parse error" pill | The project's own `dbt parse` fails. Click the pill for the output |
| Columns view: `No python with sqlglot` | `pip install sqlglot` into the project's dbt venv, or install `uv` |
| Changes to jordag's own code don't show | `jordag restart` |
