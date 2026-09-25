// dbt node selection syntax, evaluated client-side over the slim manifest graph.
// union (space), intersection (,), N+x / x+N graph operators, @x, globs, and methods:
// fqn (default), tag, path, file, source, exposure, metric, semantic_model, saved_query, unit_test,
// resource_type, package, config.<key>, group, access, test_type, test_name, state:modified|new|unmodified

const reCache = new Map();
export function glob(pattern, s) {
  let re = reCache.get(pattern);
  if (!re) {
    re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    reCache.set(pattern, re);
  }
  return re.test(s ?? '');
}

export function index(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const parents = new Map(nodes.map(n => [n.id, n.parents.filter(p => byId.has(p))]));
  const children = new Map(nodes.map(n => [n.id, []]));
  for (const [id, ps] of parents) for (const p of ps) children.get(p).push(id);
  return { nodes, byId, parents, children };
}

function walk(ids, adj, depth = Infinity) {
  const out = new Set();
  let frontier = [...ids];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const id of frontier) for (const x of adj.get(id) || []) if (!out.has(x)) { out.add(x); next.push(x); }
    frontier = next;
  }
  return out;
}

const PARSED = new Set(['model', 'seed', 'snapshot', 'test', 'analysis', 'unit_test', 'operation']);

// port of dbt's is_selected_node: exact parts until the first wildcard part, then glob the dotted remainder
function fqnSelected(fqn, v) {
  if (glob(v, fqn[fqn.length - 1])) return true;
  const flat = fqn.flatMap(s => s.split('.'));
  const parts = v.split('.');
  if (parts.length > flat.length) return false;
  for (let i = 0; i < parts.length; i++) {
    if (/[*?[\]]/.test(parts[i])) return glob(parts.slice(i).join('.'), flat.slice(i).join('.'));
    if (parts[i] !== flat[i]) return false;
  }
  return true;
}

// like dbt, match with or without the leading package name (marts.orders == my_project.marts.orders)
const fqnMatch = (n, v) => PARSED.has(n.type) && (fqnSelected(n.fqn, v) || fqnSelected(n.fqn.slice(1), v));

const named = type => (n, v) => {
  if (n.type !== type) return false;
  const p = v.split('.');
  return p.length > 1 ? glob(p[0], n.pkg) && glob(p.slice(1).join('.'), n.name) : glob(v, n.name);
};

function configValue(n, key) {
  let x = n.config;
  for (const k of key.split('.')) x = x?.[k];
  return x;
}

const valueMatch = (x, v) => x != null && (Array.isArray(x) ? x.some(i => glob(v, String(i))) : glob(v, String(x)));

export const METHODS = {
  fqn: fqnMatch,
  tag: (n, v) => n.tags.some(t => glob(v, t)),
  path: (n, v) => {
    v = v.replace(/^\.\//, '').replace(/\/+$/, '');
    const p = n.path || '';
    return p === v || p.startsWith(v + '/') || glob(v, p);
  },
  file: (n, v) => {
    const base = (n.path || '').split('/').pop();
    return glob(v, base) || glob(v, base.replace(/\.[^.]+$/, ''));
  },
  source: (n, v) => {
    if (n.type !== 'source') return false;
    const p = v.split('.');
    const [pkg, src, tbl] = p.length >= 3 ? p : p.length === 2 ? ['*', ...p] : ['*', p[0], '*'];
    return glob(pkg, n.pkg) && glob(src, n.source_name) && glob(tbl, n.name);
  },
  exposure: named('exposure'),
  metric: named('metric'),
  semantic_model: named('semantic_model'),
  saved_query: named('saved_query'),
  unit_test: named('unit_test'),
  resource_type: (n, v) => n.type === v,
  package: (n, v, ctx) => glob(v === 'this' ? ctx.root : v, n.pkg),
  group: (n, v) => valueMatch(n.config.group, v),
  access: (n, v) => valueMatch(n.config.access, v),
  test_name: (n, v) => glob(v, n.test_name),
  test_type: (n, v) => n.type === 'unit_test' ? v === 'unit'
    : n.type === 'test' && (v === 'data' || v === (/\.ya?ml$/.test(n.path || '') ? 'generic' : 'singular')),
  state: (n, v) => v === 'new' ? n.state === 'new'
    : v === 'unmodified' ? !n.state
    : v === 'old' ? n.state !== 'new'
    : v.startsWith('modified') ? !!n.state
    : err(`unknown state "${v}" (try modified, new, unmodified)`),
};

function err(msg) { throw new Error(msg); }

const ATOM = /^(@)?(?:(\d*)\+)?(.+?)(?:\+(\d*))?$/;

export function parseAtom(s) {
  const m = ATOM.exec(s);
  if (!m) err(`can't parse "${s}"`);
  const [, at, up, body, down] = m;
  const i = body.indexOf(':');
  let method = i > 0 ? body.slice(0, i) : null;
  const value = i > 0 ? body.slice(i + 1) : body;
  if (!method) method = value.includes('/') ? 'path' : /\.(sql|py|csv|ya?ml)$/.test(value) ? 'file' : 'fqn';
  if (!METHODS[method] && !method.startsWith('config.')) err(`unknown method "${method}:"`);
  if (!value) err(`"${s}" needs a value`);
  return { at: !!at, up, down, method, value };
}

function evalAtom(g, s, ctx, matched) {
  const { at, up, down, method, value } = parseAtom(s);
  const key = method.startsWith('config.') ? method.slice(7) : null;
  const fn = key ? n => valueMatch(configValue(n, key), value) : n => METHODS[method](n, value, ctx);
  const base = new Set(g.nodes.filter(fn).map(n => n.id));
  base.forEach(id => matched?.add(id));
  const out = new Set(base);
  const depth = d => d === '' ? Infinity : +d;
  if (at) {
    walk(base, g.children).forEach(x => out.add(x));
    walk(out, g.parents).forEach(x => out.add(x));
  } else {
    if (up !== undefined) walk(base, g.parents, depth(up)).forEach(x => out.add(x));
    if (down !== undefined) walk(base, g.children, depth(down)).forEach(x => out.add(x));
  }
  return out;
}

function evalExpr(g, expr, ctx, matched) {
  const out = new Set();
  for (const term of expr.trim().split(/\s+/)) {
    let acc = null;
    for (const a of term.split(',').filter(Boolean)) {
      const s = evalAtom(g, a, ctx, matched);
      acc = acc ? new Set([...acc].filter(x => s.has(x))) : s;
    }
    acc?.forEach(x => out.add(x));
  }
  return out;
}

// -> { ids: Set of selected unique_ids, matched: Set directly matched by a selector atom (pre graph-operator) }
export function select(g, sel = '', exc = '', ctx = {}) {
  const matched = new Set();
  const ids = sel.trim() ? evalExpr(g, sel, ctx, matched) : new Set(g.byId.keys());
  if (exc.trim()) for (const id of evalExpr(g, exc, ctx)) ids.delete(id);
  return { ids, matched };
}
