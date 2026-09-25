#!/usr/bin/env node
// jordag query: dbt-selector lookups against jordag's live parse, without running dbt. Run via `jordag query ...`.
//
//   jordag query [-s SELECT] [-x EXCLUDE] [-p PROJECT_DIR] [--tests]
//       nodes matching a dbt selector, with their state vs the branch's base (new / modified)
//   jordag query ... --usage [7|30|90] [--verdict unused|dormant|team|pipeline|active|new]
//       adds prod usage per node from Snowflake ACCESS_HISTORY (verdict, consumer queries, dashboards, last read)
//   jordag query --column NODE.COLUMN [--up|--down]    every upstream/downstream column, with computed ones' SQL
//   jordag query --column NODE                          that node's columns
//
// Starts the jordag server if needed and waits for whatever the answer depends on (parse, base diff, usage, lineage).
// Every answer ends with a `url:` line that opens the same view in the jordag UI.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(fileURLToPath(import.meta.url));
const { index, select } = await import(path.join(repo, 'web/selector.js'));
const { summarize, fmt, since } = await import(path.join(repo, 'web/usage.js'));

const USAGE = 'usage: jordag query [-s SELECT] [-x EXCLUDE] [-p PROJECT_DIR] [--tests] [--usage [7|30|90] [--verdict V]] [--column NODE[.COLUMN] [--up|--down]]';
const FLAGS = { '-s': 'sel', '--select': 'sel', '-x': 'exc', '--exclude': 'exc', '-p': 'proj', '--project': 'proj', '-c': 'column', '--column': 'column', '--verdict': 'verdict' };
const opt = { win: 30, dir: 'both' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--tests') opt.tests = true;
  else if (a === '--up' || a === '--down') opt.dir = a.slice(2);
  else if (a === '--usage' || a === '-u') { opt.usage = true; if (/^(7|30|90)$/.test(argv[i + 1])) opt.win = +argv[++i]; }
  else if (FLAGS[a]) opt[FLAGS[a]] = argv[++i];
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else { console.error(`unknown argument ${a}\n${USAGE}`); process.exit(2); }
}

let dir = path.resolve(opt.proj || '.');
while (!existsSync(path.join(dir, 'dbt_project.yml'))) {
  if (path.dirname(dir) === dir) { console.error('not inside a dbt project; pass -p <project dir>'); process.exit(1); }
  dir = path.dirname(dir);
}
dir = realpathSync(dir);

// starts the server if needed; its printed URL carries the port
let printed;
try {
  printed = execFileSync('python3', [path.join(repo, 'jordag.py'), '--print', dir]).toString().trim();
} catch (e) {
  process.exit(e.status || 1);  // jordag.py already explained why on stderr
}
const server = new URL(printed).origin;
const get = p => fetch(server + p).then(r => r.json());
const q = `p=${encodeURIComponent(dir)}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (what, fn, secs = 180) => {
  for (const t0 = Date.now(); ; await sleep(1500)) {
    const r = await fn();
    if (r) return r;
    if (Date.now() - t0 > secs * 1000) { console.error(`timed out waiting for ${what}`); process.exit(1); }
  }
};

await waitFor('jordag to parse', async () => {
  const s = await get(`/api/status?${q}&auto=1`);
  if (s.parsing || (s.stale && !s.error) || s.base?.status === 'building') return null;
  if (s.error) console.error(`warning: dbt parse failed${s.mtime ? ', showing the last good manifest' : ''}:\n${s.error.split('\n').slice(-8).join('\n')}\n`);
  return s;
});

const d = await get(`/api/graph?${q}`);
if (!d.nodes) { console.error(d.error || 'no manifest yet'); process.exit(1); }
const g = index(d.nodes);
const label = n => n.type === 'source' ? `${n.source_name}.${n.name}` : n.label || n.name;
const params = new URLSearchParams({ p: dir });

if (opt.column) {  // ---------------------------------------------------------------- column trace
  const find = name => g.nodes.find(n => n.id === name) || g.nodes.find(n => ['model', 'source', 'seed', 'snapshot'].includes(n.type) && label(n) === name);
  const i = opt.column.lastIndexOf('.');
  const whole = find(opt.column);  // a bare node (sources are src.table, so try the whole string first)
  const node = whole || find(opt.column.slice(0, i));
  const col = whole ? '' : opt.column.slice(i + 1).toUpperCase();
  if (!node) { console.error(`no model/source/seed/snapshot named "${whole ? opt.column : opt.column.slice(0, i)}" (use NODE or NODE.COLUMN, e.g. orders.customer_id)`); process.exit(1); }
  if (!col) {  // just list the node's columns
    const r = await waitFor('column lineage (compiles + traces the project, ~1 min the first time)', async () => {
      const x = await get(`/api/columns?${q}&id=${encodeURIComponent(node.id)}`);
      if (x.status === 'error' && !x.columns) { console.error(`column lineage failed:\n${x.error}`); process.exit(1); }
      return x.status === 'ready' ? x : null;
    }, 300);
    params.set('m', 'columns');
    params.set('n', node.id);
    console.log(`${path.basename(dir)} · ${d.branch}`);
    console.log(`url: ${server}/?${params}`);
    console.log(`${label(node)}: ${r.columns.length} columns (inputs ↑ / columns fed downstream ↓)`);
    for (const c of r.columns) console.log(`  ${c.col.toLowerCase()}\t↑${c.up}\t↓${c.down}`);
    process.exit(0);
  }
  const t = await waitFor('column lineage (compiles + traces the project, ~1 min the first time)', async () => {
    const r = await get(`/api/columns?${q}&id=${encodeURIComponent(node.id)}&col=${encodeURIComponent(col)}&dir=${opt.dir}`);
    if (r.status === 'error' && !r.nodes) { console.error(`column lineage failed:\n${r.error}`); process.exit(1); }
    return r.status === 'ready' ? r : null;
  }, 300);
  params.set('m', 'columns');
  params.set('c', `${node.id}|${col}`);
  if (opt.dir !== 'both') params.set('cd', opt.dir);
  const key = (id, c) => `${id}|${c}`, start = key(node.id, col);
  const byKey = new Map(t.nodes.map(n => [key(n.id, n.col), n]));
  const name = k => { const j = k.lastIndexOf('|'), id = k.slice(0, j); return `${g.byId.get(id) ? label(g.byId.get(id)) : id}.${k.slice(j + 1).toLowerCase()}`; };
  const walk = forward => {  // BFS from the focus, one line per column with its depth
    const out = [], seen = new Set([start]);
    let frontier = [start];
    for (let depth = 1; frontier.length; depth++) {
      const next = [];
      for (const k of frontier) for (const [a, b] of t.edges) {
        const [from, to] = forward ? [a, b] : [b, a];
        if (from === k && !seen.has(to)) { seen.add(to); next.push(to); out.push([depth, to]); }
      }
      frontier = next;
    }
    return out;
  };
  const line = ([depth, k]) => { const n = byKey.get(k) || {}; return `${'  '.repeat(depth)}${name(k)}${n.t ? `  ƒ ${n.expr || ''}` : ''}`; };
  const f = byKey.get(start) || {};
  console.log(`${path.basename(dir)} · ${d.branch}`);
  console.log(`url: ${server}/?${params}`);
  if (t.missing) { console.log(`${label(node)} has no column ${col.toLowerCase()}`); process.exit(1); }
  console.log(`${name(start)}${f.t ? `  ƒ ${f.expr}` : ''}${f.desc ? `\n  doc: ${f.desc.split('\n')[0]}` : ''}${t.truncated ? '\n(truncated at 600 columns: use --up or --down)' : ''}`);
  if (opt.dir !== 'down') { const up = walk(false); console.log(`\nupstream (${up.length}):`); up.forEach(x => console.log(line(x))); }
  if (opt.dir !== 'up') { const down = walk(true); console.log(`\ndownstream (${down.length}):`); down.forEach(x => console.log(line(x))); }
  process.exit(0);
}

const { ids } = select(g, opt.sel || '', opt.exc || '', { root: d.project });
const rows = [...ids].map(id => g.byId.get(id)).filter(n => opt.tests || !['test', 'unit_test'].includes(n.type));
rows.sort((a, b) => (!a.state - !b.state) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

let u = null;
if (opt.usage) {
  u = await waitFor('usage from ACCESS_HISTORY (~1 min when stale)', async () => {
    const r = await get(`/api/usage?${q}`);
    if (r.unsupported) { console.error(r.unsupported); process.exit(1); }
    if (r.error && !r.at && !r.fetching) { console.error(`usage unavailable: ${r.error}`); process.exit(1); }
    return r.fetching && !r.at ? null : r;
  }, 300);
  if (u.hint) console.error(`note: ${u.hint}`);
  params.set('m', 'usage');
  if (opt.verdict) params.set('v', opt.verdict);
  if (opt.win !== 30) params.set('w', opt.win);
}

const b = d.base;
if (opt.sel) params.set('s', opt.sel);
if (opt.exc) params.set('x', opt.exc);
const changed = d.nodes.filter(n => n.state && !['test', 'unit_test'].includes(n.type)).length;
console.log(`${path.basename(dir)} · ${d.branch} · ${b ? `vs ${b.ref}@${b.sha.slice(0, 7)}${b.status === 'ready' ? '' : ` (diff ${b.status})`}` : 'no git base'}`);
console.log(`url: ${server}/?${params}`);
console.log(`${rows.length} node${rows.length === 1 ? '' : 's'} selected${opt.tests ? '' : ' (tests hidden)'} · ${changed} changed in project${d.removed?.length ? ` · removed: ${d.removed.join(', ')}` : ''}`);
if (u) {
  const counts = {};
  for (const n of rows) { const v = summarize(u, g, n.id, opt.win).verdict; if (v) counts[v] = (counts[v] || 0) + 1; }
  console.log(`usage (${opt.win}d, ACCESS_HISTORY as of ${since(u.at * 1000)}; consumers = ${u.consumer_roles.length ? u.consumer_roles.filter(r => !u.legacy_roles.includes(r)).join(', ') + (u.legacy_roles.length ? ` + legacy ${u.legacy_roles.join(', ')}` : '') : 'any non-pipeline, non-team role'}; team = people using ${u.team_roles.join(', ')} (${u.team_users.join(', ')}); pipeline = ${u.pipeline_roles.join(', ')}): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  console.log(['state', 'type', 'name', 'verdict', `queries_${opt.win}d`, 'consumer_roles', 'dashboards', 'team_queries', 'other_queries', 'last_read', 'last_built', 'unique_id'].join('\t'));
}
for (const n of rows) {
  if (!u) { console.log([n.state || '-', n.type, label(n), n.id, n.path || ''].join('\t')); continue; }
  const s = summarize(u, g, n.id, opt.win);
  if (!s.verdict || (opt.verdict && s.verdict !== opt.verdict)) continue;  // exposures/tests/ephemeral have no prod relation
  console.log([n.state || '-', n.type, label(n), s.verdict || '-', fmt(s.reads), s.consumers.slice(0, 3).map(c => `${c[0]}:${fmt(c[1])}`).join(',') || '-',
    s.dash.map(x => '#' + x[0] + (u.names?.dash?.[x[0]] ? ` ${u.names.dash[x[0]]}` : '')).join(',') || '-',
    fmt(s.team.reduce((a, x) => a + x[1], 0)), fmt(s.other.reduce((a, x) => a + x[1], 0)), since(s.lastRead), since(s.lastBuilt), n.id].join('\t'));
}
