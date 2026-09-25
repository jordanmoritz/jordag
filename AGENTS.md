# Setting up jordag (for AI agents)

Follow these steps in order to install jordag for a user and prove it works. Every command is non-interactive. Run them from the repo root unless a step says otherwise.

## 1. Check prerequisites

```bash
python3 --version   # 3.9 or newer
git --version
node --version      # 18 or newer (needed for `jordag query` and the skills)
```

If `node` is missing, the viewer still works but the skills won't. Tell the user.

## 2. Check for another copy, then install

Developers often already have jordag installed or running. Check first:

```bash
python3 jordag.py status
```

This prints which copy this is, the config, cache and port it would use, whether a server is running on that port (and whose), and which `jordag` is on `PATH`.

**If nothing says `ANOTHER copy`**, install normally:

```bash
python3 jordag.py setup     # links ~/.local/bin/jordag and ~/.claude/skills/jordag*
```

Then run `python3 jordag.py status` again. `on PATH` should say `this copy`. If it says `not on PATH`, tell the user to add `~/.local/bin` to `PATH`, and use `python3 <repo>/jordag.py` wherever these steps say `jordag`.

**If anything says `ANOTHER copy`**, don't touch it. Install side by side into a folder of your own, and give this copy its own port, cache, and config:

```bash
SANDBOX=/path/to/a/new/folder
python3 jordag.py setup --bin $SANDBOX/bin --skills $SANDBOX/skills
```

From here on, run every `jordag` command in this form. Agent shells often don't keep `export`s or `cd`s between calls, so put everything on each line:

```bash
JORDAG_PORT=8793 XDG_CACHE_HOME=$SANDBOX/cache JORDAG_CONFIG=$SANDBOX/config.json $SANDBOX/bin/jordag <arguments>
```

`8793` is only an example; any free port works. Also note:
- jordag refuses to use another copy's server: it exits 2 and prints the right command for this copy.
- `stop` and `restart` leave another copy's server alone unless you add `--force`. Ask the user before forcing, since it may be their running copy.
- Installed skills call whichever `jordag` is first on `PATH`, with the default port. A side-by-side install is for testing from the shell.

`setup --help` lists setup's options. `missing dbt` in setup's output is expected when dbt lives in project virtualenvs; the demo gets one in step 3.

## 3. Verify with the demo project

Run these from the repo root. `-p demo` points jordag at the demo, so there's no `cd` to lose.

```bash
python3 -m venv demo/.venv
demo/.venv/bin/pip install dbt-duckdb sqlglot
node test.mjs                                           # expect: "selector ok" and "usage ok"
jordag query -p demo -s '+customers'                    # expect: "8 nodes selected" (5 model rows, 3 source rows)
jordag query -p demo --column customers.lifetime_value  # expect: "upstream (3)", ending at shop.raw_payments.amount
jordag query -p demo -s orders --usage                  # expect: "Usage reads Snowflake ACCESS_HISTORY; this project uses duckdb." and exit code 1
```

Notes:
- The first `--column` run compiles the demo and traces every column, which takes a few seconds. dbt-duckdb creates `demo/demo.duckdb` (gitignored) along the way.
- Every successful `jordag query` prints a `url:` line near the top that opens the same view.
- `--usage` exits 1 on non-Snowflake projects, so don't chain it with `&&`.
- To see the UI, run `jordag demo` (it opens the browser), or `jordag --print demo` for the URL to open in an embedded browser.

When you're done, stop the server you started: `jordag stop`, in the same side-by-side form if you used one.

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
| `port … is served by another jordag` | Another copy, or an older version of this one, owns the port. Run beside it (see step 2), or, with the user's OK, `jordag restart --force` |
| `server failed to start` | See `$XDG_CACHE_HOME/jordag/server.log` (default `~/.cache/jordag/server.log`). Usually the port is taken: set `JORDAG_PORT` |
| Red "parse error" pill | The project's own `dbt parse` fails. Click the pill for the output |
| Columns view: `No python with sqlglot` | `pip install sqlglot` into the project's dbt venv, or install `uv` |
| Changes to jordag's own code don't show | `jordag restart` |
