---
name: jordag-usage
description: Check how production actually uses dbt models, sources, or a whole folder, and pull it up in jordag's Usage view. Data comes from Snowflake ACCESS_HISTORY, classified by the role behind each query (consumers, team, pipeline). Use when the user asks to check usage; whether a model is used or safe to remove; who or what reads it; which Metabase dashboards or questions use it; what's unused, dead, or stale in a folder or on their branch; or whether their changed models are used in prod. Snowflake projects only.
---

# jordag-usage

jordag's Usage view shows prod reads per node from `SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY`, fetched through the project's own dbt connection and cached for 12h. It only works for Snowflake projects; on any other adapter `jordag query --usage` says so.

## Pull up usage

1. **Pick the project.** Use the dbt project or worktree this session works in, unless the user names another. `-p <dir>` targets another.
2. **Pick the selection and verdict** based on what they asked:
   - One model ("is orders used?", "who reads X?"): `-s <name>`. For a source, `-s source:src.table`.
   - A folder ("what's unused in marts?"): `-s path:models/marts` with `--verdict unused`.
   - Their branch ("are my changes used?"): `-s state:modified`.
   - "What can we clean up?": no `-s`, with `--verdict unused`. Then offer `--verdict dormant` for nodes with no activity in 90 days.
   - A time window, if they give one: `--usage 7` or `--usage 90`. The default is 30 days.
3. **Run:** `jordag query -s '<selection>' --usage [7|30|90] [--verdict unused|dormant|team|pipeline|active|new]`
   - It prints one tab-separated row per node: verdict, consumer queries, consumer roles, Metabase dashboards, team queries, other queries, last read, last built, unique_id.
   - It also prints a `url:` for the same Usage view.
   - If the cache is stale, the first run waits about a minute for Snowflake.
   - A `note:` line means config is missing: without `prod_database` and `prod_schema` only sources are covered. See the jordag README's configuration section, and tell the user.
4. **Open the `url:`** in the browser (the built-in browser pane if there is one). For a single model, append `&n=<unique_id>` to open its panel, which shows readers by role, Metabase dashboards, and questions.
5. **Answer in a sentence or two** from the output: the verdict and the numbers behind it, and for a list, the count per verdict.
   Call out declared exposures on nodes that are otherwise unused; they're likely stale.

## What the verdicts mean

Readers are classified by the role behind each query, as set in `~/.config/jordag/config.json`:
- **Consumers** are `consumer_roles` and `legacy_consumer_roles`. If none are configured, every role that isn't pipeline or team counts.
- **Team** is anyone who uses one of `team_roles`, whatever role a given query ran under.
- **Pipeline** is the roles that write objects (dbt, loaders), detected automatically.
- **Other** is shown, but never changes a verdict.

The verdicts:
- `unused`: no consumer or team reads, and nothing downstream. A cleanup candidate.
- `dormant` ("no activity"): not read or rebuilt in 90 days.
- `team` ("team only"): no consumer reads, but the team reads it.
- `pipeline`: only feeds downstream models.
- `active`: read by consumers.
- `new` ("not in prod"): new on this branch.

Metabase fingerprinting queries are excluded. ACCESS_HISTORY lags about 3h. Dashboard and question names show only when `METABASE_API_KEY` is set wherever the jordag server runs.
