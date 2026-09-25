# Setting up jordag (for AI agents)

Follow these steps in order to install jordag for a user and prove it works. Every command is non-interactive. Run them from the repo root.

Every command in steps 2 and 3 runs this checkout as `python3 jordag.py ...`, so they work the same whether or not another jordag is installed. Keep it that way: a bare `jordag` on `PATH` may be a different copy.

## 1. Check prerequisites

```bash
python3 --version   # 3.9 or newer
git --version
node --version      # 18 or newer (needed for `jordag query` and the skills)
```

If `node` is missing, the viewer still works but the skills won't. Tell the user.

## 2. Install

Developers often already have jordag installed or running. Check first:

```bash
python3 jordag.py status
```

It prints this checkout's config, cache and port, whether a server is running there (and whose), and which `jordag` is on `PATH`.

**If no line says `ANOTHER copy`**, do a normal install:

```bash
python3 jordag.py setup
```

This links `~/.local/bin/jordag` and `~/.claude/skills/jordag*`.
- Run `python3 jordag.py status` again. `on PATH` should say `this copy`.
- If it says `not on PATH`, tell the user to add `~/.local/bin` to their `PATH`. Everything below still works.

**If any line says `ANOTHER copy`**, the user already runs jordag. Don't touch it. Install this checkout into a sandbox folder of your own instead:

```bash
python3 jordag.py setup --sandbox ../jordag-sandbox    # any new folder outside the repo (relative paths are fine)
```

This gives this checkout:
- its own free port, picked automatically
- its own cache and config under that folder (the config file doesn't need to exist)
- links to `bin/` and `skills/` in that folder

It saves those settings in `.jordag-local.json` in the repo (gitignored), so every `python3 jordag.py ...` from this checkout uses them automatically. Delete that file to undo.

Afterwards, `python3 jordag.py status` should show:
- `sandbox yes`
- `config` and `cache` inside your sandbox folder, and a `port` that isn't the other copy's
- `server not running` (or `running, this copy` once you've used it)

`on PATH` still names the other copy. That's fine; just never run the bare `jordag` command, because it's the user's.

The skills linked into the sandbox folder are only there so you can check the links. Agents never load them from there, and they would call the bare `jordag` anyway.

Re-running `setup --sandbox` is safe: it stops this sandbox's server and moves it to a new free port.

In either case, setup ends by checking for dbt, node and git. It only prints the missing ones, so no `missing` line means all three were found. `missing dbt` is expected when dbt lives in project virtualenvs; the demo gets one next.

## 3. Verify with the demo project

```bash
python3 -m venv demo/.venv
demo/.venv/bin/pip install dbt-duckdb sqlglot
node test.mjs                                                     # expect: "selector ok" and "usage ok"
python3 jordag.py query -p demo -s '+customers'                   # expect: "8 nodes selected" (5 model rows, 3 source rows)
python3 jordag.py query -p demo --column customers.lifetime_value # expect: "upstream (3)", ending at shop.raw_payments.amount
python3 jordag.py query -p demo -s orders --usage                 # expect: "Usage reads Snowflake ACCESS_HISTORY; this project uses duckdb." and exit code 1
python3 jordag.py --print demo                                    # expect: a URL on this checkout's port; curl it to get the HTML page
python3 jordag.py stop                                            # expect: "stopped the server on port …"
```

What to expect along the way:
- **pip noise:** pip may warn about its own version, or LibreSSL on macOS's system Python. Both are harmless.
- **Server:** any `query` or `--print` starts the background server on this checkout's port if it isn't running, including after `stop`.
- **Output:** every successful `query` prints a `url:` line near the top, which opens the same view in the browser.
- **Column trace:** the first `--column` run compiles the demo and traces every column, which takes a few seconds. dbt-duckdb creates `demo/demo.duckdb` (gitignored).
- **Usage:** `--usage` exits 1 on non-Snowflake projects, so don't chain it with `&&`.
- **Browser:** to show the user the UI, run `python3 jordag.py demo`, which opens their browser.
- **README examples:** they're written to run from inside a project. From the repo root, add `-p demo`, e.g. `python3 jordag.py query -p demo --column customers.lifetime_value --up`.
  The `--usage` example exits 1 on the demo with the Snowflake-only message, which is expected.

**Exit code 2** means another jordag owns the port. jordag refuses to use, stop, or restart another copy's server unless you pass `--force`. Ask the user before forcing, since it may be their running copy.

## 4. Point it at the user's projects

From inside any of the user's dbt projects, run `jordag` (or `python3 <repo>/jordag.py`). The project and all its git worktrees appear in the dropdown from then on. To also list projects that haven't been opened yet, add their parent folders to `roots` in the config file that `status` shows.

jordag finds dbt in the project's `.venv` or `venv`, then in the main worktree's, then on `PATH`. Parse errors show in the UI's status pill.

The installed skills call whichever `jordag` is first on `PATH`, so they use the normal install, not a sandbox.

## 5. Usage view (Snowflake only)

Ask the user for these, then write the config file that `status` shows (see `config.example.json` and the README's configuration table):
- The production database and default schema.
- Whether prod uses bare custom schemas (`"custom"`) or dbt's default prefixing (`"prefixed"`).
- The Snowflake roles their BI tools use (consumers) and the roles people use (team).

Then run `jordag restart`, and from their project, `jordag query --usage`. The first run takes about a minute.

Their dbt role needs to be able to read `SNOWFLAKE.ACCOUNT_USAGE`. If it can't, the query output shows Snowflake's error; tell the user.

For Metabase dashboard names, the user sets `METABASE_API_KEY` in their shell and runs `jordag restart`. Don't ask them to give you the key.

## HTTP API

`jordag query` is the supported interface. For scripts, the server's JSON endpoints all take `p=<url-encoded absolute path of the dbt project>`:
- `/api/projects`
- `/api/graph?p=` (every node, tests included, so its count is higher than `query`'s, which hides tests)
- `/api/node?p=&id=<unique_id>`
- `/api/usage?p=`
- `/api/columns?p=&id=<unique_id>[&col=<COLUMN>&dir=up|down|both]`

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Exit code 2: `port … is served by another jordag` | Another copy, or an older version of this one, owns the port. Use `setup --sandbox` (step 2), or, with the user's OK, `restart --force` |
| `server failed to start` | See `server.log` in the cache folder that `status` shows. Usually the port is taken by something that isn't jordag: rerun `setup --sandbox` to move to another free port |
| `dbt parse finished but wrote no manifest` | jordag can't write to the cache folder that `status` shows. Check it's writable, or rerun `setup --sandbox` with another folder |
| Red "parse error" pill | The project's own `dbt parse` fails. Click the pill for the output |
| Columns view: `No python with sqlglot` | `pip install sqlglot` into the project's dbt venv, or install `uv` |
| Changes to jordag's own code don't show | `python3 jordag.py restart` |
