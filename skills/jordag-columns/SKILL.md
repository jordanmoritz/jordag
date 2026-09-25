---
name: jordag-columns
description: Column-level lineage for dbt, pulled up in jordag's Columns view. Traces one column upstream to its source columns and downstream to everything that uses it, and shows the SQL of computed columns (sqlglot over the compiled project). Use when the user asks for column lineage or to trace a column; where a column comes from; what uses a column or would break if it's renamed or dropped; or how a column or metric is computed or derived.
---

# jordag-columns

jordag's Columns view draws one column's path through the DAG, as model cards holding only the columns on that path.
- It works on any dbt adapter sqlglot understands (Snowflake, BigQuery, Databricks, Postgres, Redshift, DuckDB, …).
- The first run in a project compiles it into jordag's cache and traces every column, which takes seconds to about a minute. After that, only changed models re-trace.

## Pull up a column

1. **Pick the project.** Use the dbt project or worktree this session works in, unless the user names another. `-p <dir>` targets another.
2. **Name the column** as `<node>.<column>`, e.g. `customers.lifetime_value`. For a source column, `shop.raw_orders.status`. Case doesn't matter.
   - If they name only a model ("column lineage for customers"), list its columns: `jordag query --column customers`.
     Then open that URL (the picker shows every column with input and downstream counts), or ask which column they mean.
   - If the column name is wrong, the output says so. List the columns and pick the closest match.
3. **Choose a direction** based on the question:
   - "Where does it come from?" or "how is it computed?": `--up`.
   - "What uses it?" or "what breaks if I change it?": `--down`.
   - Otherwise both, which is the default.
4. **Run:** `jordag query --column <node>.<column> [--up|--down]`
   - It prints the focus column (with its SQL if computed, and its doc if documented), then upstream and downstream columns, indented by hop count.
   - Computed columns are marked `ƒ` with their expression.
   - It also prints a `url:` for the same view.
5. **Open the `url:`** in the browser (the built-in browser pane if there is one).
6. **Answer from the output.** For "how is X computed", quote the expression and walk the upstream chain down to source columns. For "what uses X", count the downstream columns and models, and name the notable ones.

## Notes
- Source columns come from Snowflake's `information_schema` on Snowflake, otherwise from `target/catalog.json` (`dbt docs generate`), falling back to columns declared in yml. Undeclared source columns can't expand `select *`.
- Constants and `count(*)`-style columns have no inputs, which is expected.
- Traces cap at 600 columns. If the output says truncated, re-run with `--up` or `--down`.
- In the view, the user can click a column for its SQL, double-click to re-trace from it, and click a card title to list that node's columns.
