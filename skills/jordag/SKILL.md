---
name: jordag
description: Pull up the dbt DAG (lineage graph) in the browser using jordag, a local live dbt DAG viewer. By default it shows what the current branch or worktree changed vs the default branch. Use when the user asks to pull up, show, or visualize the DAG or lineage; to see their changes or what a branch or PR touches; or asks what's upstream or downstream of a model or what a change impacts. For prod usage questions use jordag-usage; for column-level lineage use jordag-columns.
---

# jordag

jordag is a local, live dbt DAG viewer.
- It serves every dbt project and git worktree on the machine from one background server (default `http://127.0.0.1:8765`).
- It re-parses about 2s after files change.
- It diffs each worktree node by node against its merge-base with the remote default branch.

It has three views:
- **Graph** (this skill).
- **Usage** (the `jordag-usage` skill).
- **Columns** (the `jordag-columns` skill).

All of them use `jordag query`, run from inside the dbt project.
- It starts the server if needed and waits for the parse.
- It prints results plus a `url:` line that opens the same view.
- `-p <dir>` targets another project or worktree. To list them with their branches, curl `<server>/api/projects`, where `<server>` is the scheme, host and port from any `url:` line.

If `jordag` isn't on PATH, run `python3 <jordag checkout>/jordag.py setup` first (see its README).

## Pull up the DAG

1. **Pick the project.** Use the dbt project or worktree this session is working in, unless the user names another one.
2. **Pick the selection** based on what they asked:
   - "Pull up the DAG", "show my changes", "what did I change", "compare to prod/main": use `1+state:modified+`. That means changed nodes, their direct parents, and everything downstream.
   - A named model: use `+name+`. For a source, use `+source:src.table+`. Then open that node's panel (step 4).
   - Anything else: translate it to dbt selector syntax. Examples: `tag:x`, `path:models/marts`, `staging.finance`, `config.materialized:table`, `@x`, commas for intersection, spaces for union.
3. **Run:** `jordag query -s '1+state:modified+'`. It prints the nodes, changed ones first.
   If it reports 0 changed, the worktree matches its base. Drop `-s` to show the whole project and say that nothing has changed.
4. **Open the printed `url:`** in the user's browser: the built-in browser pane if the harness has one, otherwise their browser (`open <url>` on macOS).
   - Append `&n=<unique_id>` to open a node's details panel. The unique_id is the fourth column of the output.
   - Append `&l=1` for the usage lens: nodes shaded by prod reads (Snowflake projects only).
5. **Summarize in a sentence or two** what they're looking at: how many nodes changed, which are new vs modified, and any downstream exposures. Use the command output for this, not screenshots.

## Notes
- jordag never writes to the project's `target/`. Its parses and compiles go to `$XDG_CACHE_HOME/jordag` (default `~/.cache/jordag`).
- If the output shows a parse error, the project has a dbt parse error. Tell the user; the viewer keeps showing the last good graph.
- After updating jordag itself, run `jordag restart`.
