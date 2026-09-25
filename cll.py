"""Column-level lineage for a compiled dbt manifest, via sqlglot. Runs under the project's dbt venv, not jordag's python.

  python cll.py COMPILED_MANIFEST SOURCE_COLUMNS_JSON OUT_JSON PROJECT_DIR [SQLGLOT_DIALECT]

Walks models in DAG order so `select *` can expand against upstream output columns, and writes per model:
  {"order": [COL, ...], "cols": {COL: {"up": [[parent_uid_or_relation, COL], ...], "expr": sql, "t": transformed}}}
Incremental: a model whose compiled SQL and parents' columns are unchanged reuses OUT_JSON's previous result.
"""
import csv
import hashlib
import json
import os
import sys

import sqlglot
from sqlglot import exp
from sqlglot.lineage import lineage
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import build_scope
from sqlglot.schema import MappingSchema

VERSION = 2
DIALECT = None  # sqlglot dialect, from the project's dbt adapter (set in main)
SNAPSHOT_COLS = ['DBT_SCD_ID', 'DBT_UPDATED_AT', 'DBT_VALID_FROM', 'DBT_VALID_TO']


def rel_key(s):
    return '.'.join(p.strip('"').upper() for p in (s or '').split('.') if p)


def table_key(t):
    return '.'.join(p.upper() for p in (t.catalog, t.db, t.name) if p)


def bare(e):
    return isinstance(e.this if isinstance(e, exp.Alias) else e, exp.Column)


def trace_model(sql, schema, rel2uid):
    try:
        q = qualify(sqlglot.parse_one(sql, dialect=DIALECT), schema=schema, dialect=DIALECT, validate_qualify_columns=False)
        scope = build_scope(q)
    except Exception as e:
        return {'order': [], 'cols': {}, 'error': 'sqlglot: %s' % str(e)[:300]}
    order, cols = [], {}
    for name in q.named_selects:
        col = name.upper()
        if col == '*' or col in cols:
            continue
        entry = {'up': [], 'expr': '', 't': False}
        try:
            ln = lineage(name, q, schema=schema, dialect=DIALECT, scope=scope, trim_selects=False)
            ups, expr = set(), None
            for x in ln.walk():
                if x.downstream:
                    if not bare(x.expression):
                        entry['t'] = True
                        expr = expr or x.expression  # first real computation below the pass-through selects
                elif isinstance(x.source, exp.Table):
                    ups.add((rel2uid.get(table_key(x.source), table_key(x.source)), x.name.split('.')[-1].strip('"').upper()))
            entry['up'] = sorted(ups)
            entry['t'] = entry['t'] or not ups  # constants count as computed
            entry['expr'] = (expr or ln.expression).sql(dialect=DIALECT)[:800]
        except Exception as e:
            entry['error'] = str(e)[:200]
        order.append(col)
        cols[col] = entry
    return {'order': order, 'cols': cols}


def main(manifest_path, sources_path, out_path, project_dir, dialect=None):
    global DIALECT
    DIALECT = dialect or None
    m = json.load(open(manifest_path))
    source_cols = json.load(open(sources_path))
    try:
        prev = json.load(open(out_path))
        prev = prev['models'] if prev.get('version') == VERSION else {}
    except (OSError, ValueError, KeyError):
        prev = {}

    schema = MappingSchema(dialect=DIALECT)
    rel2uid, cols_of, sources = {}, {}, {}
    for uid, s in m['sources'].items():
        rel = rel_key(s.get('relation_name'))
        rel2uid[rel] = uid
        cols = source_cols.get(rel) or {c.upper(): v.get('data_type') or 'VARCHAR' for c, v in (s.get('columns') or {}).items()}
        sources[uid] = cols
        cols_of[uid] = list(cols)
        if rel and cols:
            schema.add_table(rel, cols, dialect=DIALECT)

    nodes = {u: n for u, n in m['nodes'].items() if n['resource_type'] in ('model', 'snapshot', 'seed')}
    for u, n in nodes.items():
        if n.get('relation_name'):
            rel2uid[rel_key(n['relation_name'])] = u
        if n['resource_type'] == 'seed':
            try:
                with open(os.path.join(project_dir, n['original_file_path']), newline='') as f:
                    cols_of[u] = [h.strip().upper() for h in next(csv.reader(f))]
            except (OSError, StopIteration):
                cols_of[u] = []
            if n.get('relation_name') and cols_of[u]:
                schema.add_table(rel_key(n['relation_name']), {c: 'VARCHAR' for c in cols_of[u]}, dialect=DIALECT)

    order, seen = [], set()

    def visit(u):
        if u in seen or u not in nodes or nodes[u]['resource_type'] == 'seed':
            return
        seen.add(u)
        for p in nodes[u]['depends_on']['nodes']:
            visit(p)
        order.append(u)

    sys.setrecursionlimit(10000)
    for u in nodes:
        visit(u)

    out = {}
    for i, u in enumerate(order, 1):
        n = nodes[u]
        sql = n.get('compiled_code') or ''
        h = hashlib.sha1(json.dumps([sql, [cols_of.get(p) for p in n['depends_on']['nodes']]]).encode()).hexdigest()
        res = prev.get(u) if prev.get(u, {}).get('hash') == h else None
        if res is None:
            res = trace_model(sql, schema, rel2uid)
            if n['resource_type'] == 'snapshot':
                for c in SNAPSHOT_COLS:
                    if c not in res['cols']:
                        res['order'].append(c)
                        res['cols'][c] = {'up': [], 'expr': 'dbt snapshot metadata', 't': True}
            res['hash'] = h
        out[u] = res
        cols_of[u] = res['order']
        if n.get('relation_name') and res['order']:
            schema.add_table(rel_key(n['relation_name']), {c: 'VARCHAR' for c in res['order']}, dialect=DIALECT)
        if i % 10 == 0 or i == len(order):
            print('progress %d/%d' % (i, len(order)), flush=True)

    tmp = out_path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'version': VERSION, 'models': out, 'sources': sources,
                   'seeds': {u: cols_of[u] for u, n in nodes.items() if n['resource_type'] == 'seed'}}, f)
    os.replace(tmp, out_path)


if __name__ == '__main__':
    main(*sys.argv[1:6])
