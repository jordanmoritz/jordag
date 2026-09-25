#!/usr/bin/env python3
"""jordag: a live dbt DAG viewer for every dbt project and git worktree on your machine.

  jordag [path]       open the viewer on the dbt project containing path (default: cwd),
                      starting the background server if it isn't running
  jordag --print      same, but only print the URL
  jordag setup        link the `jordag` command into ~/.local/bin and the agent skills into ~/.claude/skills
                      (--bin DIR, --skills DIR, --no-skills; --sandbox DIR to run beside another jordag)
  jordag query ...    DAG / usage / column-lineage lookups from the terminal (see `jordag query --help`)
  jordag status       which copy this is, its config/cache/port, and whether a server (and whose) is running
  jordag serve        run the server in the foreground
  jordag stop | restart   (--force to stop another copy's server on this port)

Optional config: ~/.config/jordag/config.json (see config.example.json). Env: JORDAG_CONFIG, JORDAG_PORT,
JORDAG_ROOTS (colon-separated), JORDAG_DBT (dbt binary), METABASE_API_KEY (dashboard/question names).
"""
import collections
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
# written by `jordag setup --sandbox`: this checkout's own port/cache/config, so it can run beside another jordag
LOCAL_FILE = HERE / '.jordag-local.json'
try:
    LOCAL = json.loads(LOCAL_FILE.read_text())
    for k in ('cache', 'config'):  # paths are absolute, but resolve any relative one against the checkout, not the cwd
        if LOCAL.get(k):
            LOCAL[k] = str((HERE / Path(LOCAL[k]).expanduser()).resolve())
except (OSError, ValueError):
    LOCAL = {}
# a sandbox's own settings win over the environment, so it stays isolated from the copy it runs beside
CONFIG_PATH = Path(LOCAL.get('config') or os.environ.get('JORDAG_CONFIG') or '~/.config/jordag/config.json').expanduser()
try:
    CFG = json.loads(CONFIG_PATH.read_text())
except FileNotFoundError:
    CFG = {}
except ValueError as e:
    sys.exit('jordag: %s is not valid JSON: %s' % (CONFIG_PATH, e))

PORT = int(LOCAL.get('port') or os.environ.get('JORDAG_PORT') or CFG.get('port') or 8765)
ROOTS = [Path(p).expanduser() for p in
         (os.environ['JORDAG_ROOTS'].split(':') if os.environ.get('JORDAG_ROOTS') else CFG.get('roots') or []) if p]
CACHE = Path(LOCAL['cache']) if LOCAL.get('cache') \
    else Path(os.environ.get('XDG_CACHE_HOME') or '~/.cache').expanduser() / 'jordag'
WEB, USAGE_SQL, ENGINE = HERE / 'web', HERE / 'usage.sql', HERE / 'cll.py'
USAGE_DAYS, USAGE_TTL = 90, 12 * 3600
# Usage (Snowflake only): where prod models live, and how to read the role behind each query.
#   consumer roles: whose reads count as real use (empty = every role that isn't pipeline or team)
#   team roles: people who use these are "team", whatever role a given query ran under
#   pipeline roles (dbt, loaders) are detected from writes
PROD_DB = str(CFG.get('prod_database') or '').upper()
PROD_SCHEMA = str(CFG.get('prod_schema') or '').upper()
PROD_STYLE = CFG.get('prod_schema_style') or 'prefixed'  # 'prefixed' = dbt's default <schema>_<custom>; 'custom' = bare
upper = lambda k: [str(r).upper() for r in CFG.get(k) or []]
CONSUMER_ROLES, LEGACY_ROLES, TEAM_ROLES = upper('consumer_roles'), upper('legacy_consumer_roles'), upper('team_roles')
METABASE_URL = os.environ.get('METABASE_URL') or CFG.get('metabase_url')
USAGE_VERSION = 2  # bump when usage.sql's output changes shape; older caches are ignored
SKIP = {'node_modules', 'dbt_packages', 'target', 'logs', 'venv', '__pycache__'}
SRC_EXT = {'.sql', '.yml', '.yaml', '.csv', '.md', '.py'}
SECTIONS = ('nodes', 'sources', 'exposures', 'metrics', 'semantic_models', 'saved_queries', 'unit_tests')
# keys that change between parses of identical code; everything else counts toward state:modified
VOLATILE = {'created_at', 'root_path', 'build_path', 'compiled_path', 'compiled_code', 'compiled', 'extra_ctes',
            'extra_ctes_injected', 'deferred', 'unrendered_config', 'original_file_path', 'path', 'patch_path',
            'config_call_dict', 'unrendered_config_call_dict', 'doc_blocks'}


def git(cwd, *args):
    try:
        r = subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, text=True, timeout=15)
        return r.stdout.strip() if r.returncode == 0 else ''
    except (OSError, subprocess.SubprocessError):
        return ''


def tail(text, n=40):
    return '\n'.join(text.strip().splitlines()[-n:])


FP_VERSION = 2  # bump when fingerprint() changes, invalidates cached bases


def fingerprint(n):
    body = {k: v for k, v in n.items() if k not in VOLATILE}
    # jinja loops over sets emit refs/sources in random order, and order never matters for these
    for k in ('refs', 'sources'):
        if isinstance(body.get(k), list):
            body[k] = sorted(body[k], key=lambda x: json.dumps(x, sort_keys=True))
    if isinstance(body.get('depends_on'), dict):
        body['depends_on'] = {k: sorted(v) if isinstance(v, list) else v for k, v in body['depends_on'].items()}
    return hashlib.sha1(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:16]


def macro_info(manifest):
    """Root-project macros only: {uid: (sql fingerprint, [macro deps])}."""
    root = manifest['metadata'].get('project_name')
    return {uid: (hashlib.sha1((m.get('macro_sql') or '').encode()).hexdigest()[:16],
                  (m.get('depends_on') or {}).get('macros') or [])
            for uid, m in (manifest.get('macros') or {}).items() if m.get('package_name') == root}


def slim(uid, n, fp):
    cfg = {k: v for k, v in (n.get('config') or {}).items()
           if v not in (None, [], {}, '') and k not in ('post-hook', 'pre-hook')}
    s = {'id': uid, 'name': n.get('name'), 'type': n.get('resource_type'), 'pkg': n.get('package_name'),
         'path': n.get('original_file_path'), 'fqn': n.get('fqn') or [], 'tags': n.get('tags') or [],
         'config': cfg, 'parents': (n.get('depends_on') or {}).get('nodes') or [], 'fp': fp}
    for k in ('source_name', 'label'):
        if n.get(k):
            s[k] = n[k]
    if (n.get('test_metadata') or {}).get('name'):
        s['test_name'] = n['test_metadata']['name']
    return s


# ---------------------------------------------------------------- discovery

KNOWN_FILE = CACHE / 'projects.json'  # every project opened with jordag, so it and its worktrees show up with no config
KNOWN = None


def remember(path):
    global KNOWN
    if KNOWN is None:
        try:
            KNOWN = set(json.loads(KNOWN_FILE.read_text()))
        except (OSError, ValueError):
            KNOWN = set()
    if path not in KNOWN:
        KNOWN.add(path)
        CACHE.mkdir(parents=True, exist_ok=True)
        KNOWN_FILE.write_text(json.dumps(sorted(KNOWN)))
    return KNOWN


def find_projects():
    found = {p for p in remember('') if p and os.path.isfile(os.path.join(p, 'dbt_project.yml'))}

    def walk(d, depth):
        if (d / 'dbt_project.yml').is_file():
            found.add(os.path.realpath(d))
            return
        if depth == 0:
            return
        try:
            subs = [e.path for e in os.scandir(d) if e.is_dir(follow_symlinks=False)
                    and e.name not in SKIP and not e.name.startswith('.')]
        except OSError:
            return
        for s in subs:
            walk(Path(s), depth - 1)

    for r in ROOTS:
        walk(r, 3)

    # every git worktree of a repo that holds a dbt project, wherever it lives
    out, seen_repos = {}, set()
    for p in sorted(found):
        top = git(p, 'rev-parse', '--show-toplevel')
        common = git(p, 'rev-parse', '--path-format=absolute', '--git-common-dir')
        if not top or common in seen_repos:
            out.setdefault(p, {'path': p, 'repo': Path(p).name, 'branch': ''})
            continue
        seen_repos.add(common)
        rel = os.path.relpath(p, top)
        wts = []
        for block in git(p, 'worktree', 'list', '--porcelain').split('\n\n'):
            wt, branch = None, ''
            for line in block.splitlines():
                if line.startswith('worktree '):
                    wt = line[9:]
                elif line.startswith('branch '):
                    branch = line[7:].replace('refs/heads/', '', 1)
                elif line == 'detached':
                    branch = '(detached)'
            if wt:
                wts.append((wt, branch))
        repo = Path(wts[0][0]).name if wts else Path(top).name
        for wt, branch in wts:
            cand = os.path.realpath(os.path.join(wt, rel))
            if os.path.isfile(os.path.join(cand, 'dbt_project.yml')):
                out[cand] = {'path': cand, 'repo': repo, 'branch': branch}
    for info in out.values():
        info['name'] = Path(info['path']).name
    return sorted(out.values(), key=lambda i: (i['repo'], i['name'] != i['repo'], i['path']))  # main worktree first


# ---------------------------------------------------------------- per-project state

PROJECTS = {}
LOADED = OrderedDict()  # ponytail: keep full manifests for the 4 most recently viewed projects only
BASES = {}              # base key -> {'status', 'nodes', 'macros', 'error'}
LOCK = threading.Lock()


def get_project(path):
    if not path:
        return None
    path = os.path.realpath(path)
    if not os.path.isfile(os.path.join(path, 'dbt_project.yml')):
        return None
    with LOCK:
        if path not in PROJECTS:
            PROJECTS[path] = Project(path)
            remember(path)
        return PROJECTS[path]


def run_dbt(dbt, cmd, project_dir, target, *extra):
    args = [dbt, cmd, '--project-dir', str(project_dir), '--quiet', '--no-use-colors', *extra]
    if cmd != 'deps':
        args += ['--target-path', str(target), '--log-path', str(Path(target).parent / 'logs')]
    env = dict(os.environ, DBT_SEND_ANONYMOUS_USAGE_STATS='false')
    r = subprocess.run(args, cwd=str(project_dir), capture_output=True, text=True, timeout=600, env=env)
    r.output = (r.stdout or '') + (r.stderr or '')
    return r


# ---------------------------------------------------------------- snowflake: usage (ACCESS_HISTORY) + source columns

USAGE = {'at': 0, 'objects': {}, 'pipeline_roles': [], 'team_users': [], 'fetching': False, 'error': None, 'tried': 0}
NAMES = {'dash': {}, 'card': {}, 'fetching': False, 'loaded': False}  # Metabase dashboard/question names by id
SRC_LOCK = threading.Lock()


def rel_key(s):
    return '.'.join(p.strip('"').upper() for p in (s or '').split('.') if p)


def prod_relation(n):
    """The node's relation in prod, spelled the way ACCESS_HISTORY spells it. Sources are target-independent;
    models need prod_database/prod_schema from config.
    ponytail: rule-based (prod_schema_style), not a prod-target parse; a custom generate_schema_name may need more."""
    cfg = n.get('config') or {}
    if n.get('resource_type') == 'source':
        return rel_key(n.get('relation_name')) or None
    if not (PROD_DB and PROD_SCHEMA) or n.get('resource_type') not in ('model', 'seed', 'snapshot') \
            or cfg.get('materialized') == 'ephemeral':
        return None
    custom = cfg.get('schema')
    schema = (custom if PROD_STYLE == 'custom' else '%s_%s' % (PROD_SCHEMA, custom)) if custom else PROD_SCHEMA
    return '.'.join(str(p).upper() for p in (cfg.get('database') or PROD_DB, schema, n.get('alias') or n.get('name')))


def run_show(project, sql):
    """Run SQL through the project's own dbt connection (`dbt show`), so jordag never handles credentials."""
    r = run_dbt(project.dbt(), 'show', project.path, project.cache / 'show' / 'target',
                '--inline', sql, '--limit', '1000000', '--output', 'json')
    i = r.output.rfind('{\n  "show"')
    if r.returncode or i < 0:
        raise RuntimeError(tail(r.output))
    return json.JSONDecoder().raw_decode(r.output[i:])[0]['show']


def refresh_usage(project, force=False):
    with LOCK:
        if not USAGE['at'] and (CACHE / 'usage.json').is_file():
            try:
                cached = json.loads((CACHE / 'usage.json').read_text())
                if cached.get('v') == USAGE_VERSION:
                    USAGE.update(cached)
            except ValueError:
                pass
        due = force or time.time() - USAGE['at'] > USAGE_TTL
        if due and not USAGE['fetching'] and (force or time.time() - USAGE['tried'] > 600):
            USAGE.update(fetching=True, tried=time.time())
            threading.Thread(target=_fetch_usage, args=(project,), daemon=True).start()


def _fetch_usage(project):
    try:
        models, sources = set(), set()
        for p in [project] + list(LOADED.values()):
            for uid, rel in ((p.data or {}).get('prod') or {}).items():
                (sources if uid.startswith('source.') else models).add(rel)
        if not models | sources:
            raise RuntimeError('no parsed project to look up usage for yet')
        values = ','.join("('%s')" % n.replace("'", "''") for n in sorted(models | sources))
        sql = USAGE_SQL.read_text().replace('__DAYS__', str(USAGE_DAYS)).replace('__NAMES__', values)
        objects = {}
        for r in run_show(project, sql):
            objects.setdefault(r['OBJ'], {}).setdefault(r['KIND'], []).append([r['KEY'], r['Q7'], r['Q30'], r['Q90'], r['LAST']])

        role = lambda k: k.split(':', 1)[0]
        # ponytail: a pipeline role is any non-team role that rewrote 10+ of these objects
        writes = collections.Counter(role(w[0]) for o in objects.values() for w in o.get('write', []))
        people = {k.split(':', 1)[1] for o in objects.values() for k, *_ in o.get('read', []) + o.get('write', [])
                  if role(k) in TEAM_ROLES}
        data = {'v': USAGE_VERSION, 'at': time.time(), 'objects': objects, 'team_users': sorted(people),
                'pipeline_roles': sorted(r for r, n in writes.items() if n >= 10 and r not in TEAM_ROLES)}
        (CACHE / 'usage.json').write_text(json.dumps(data))
        USAGE.update(data, error=None)
    except Exception as e:
        USAGE['error'] = str(e)
    finally:
        USAGE['fetching'] = False


def metabase_names(base):
    """Names for the dashboards/questions in usage, via the Metabase API when METABASE_API_KEY is set. Cached forever."""
    f = CACHE / 'metabase_names.json'
    with LOCK:
        if not NAMES['loaded']:
            NAMES['loaded'] = True
            try:
                NAMES.update(json.loads(f.read_text()))
            except (OSError, ValueError):
                pass
        key, base = os.environ.get('METABASE_API_KEY'), (METABASE_URL or base or '').rstrip('/')
        todo = [(k, i) for o in USAGE['objects'].values() for k in ('dash', 'card') for i, *_ in o.get(k, [])
                if i not in NAMES[k]]
        if key and base and todo and not NAMES['fetching']:
            NAMES['fetching'] = True
            threading.Thread(target=_fetch_names, args=(base, key, sorted(set(todo)), f), daemon=True).start()
    return {'dash': NAMES['dash'], 'card': NAMES['card'], 'enabled': bool(key), 'fetching': NAMES['fetching']}


def _fetch_names(base, key, todo, f):
    try:
        for kind, i in todo:
            req = urllib.request.Request('%s/api/%s/%s' % (base, 'dashboard' if kind == 'dash' else 'card', i),
                                         headers={'X-API-Key': key})
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    j = json.loads(r.read())
                NAMES[kind][i] = (j.get('name') or '#%s' % i) + (' (archived)' if j.get('archived') else '')
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
                NAMES[kind][i] = '(deleted)'
        f.write_text(json.dumps({'dash': NAMES['dash'], 'card': NAMES['card']}))
    except Exception:
        pass  # ponytail: names are a nicety; ids still link to Metabase
    finally:
        NAMES['fetching'] = False


DIALECTS = {'sqlserver': 'tsql', 'synapse': 'tsql', 'fabric': 'tsql'}  # dbt adapter -> sqlglot dialect, where they differ


def catalog_columns(project):
    """Source columns from the project's own target/catalog.json (`dbt docs generate`), for non-Snowflake adapters."""
    try:
        cat = json.loads((project.path / 'target' / 'catalog.json').read_text())
    except (OSError, ValueError):
        return {}
    return {rel_key('%s.%s.%s' % (t['metadata'].get('database') or '', t['metadata']['schema'], t['metadata']['name'])):
            {c.upper(): v.get('type') or 'VARCHAR' for c, v in t['columns'].items()} for t in cat.get('sources', {}).values()}


def source_columns(project, rels):
    """{relation: {COL: type}} for source tables from information_schema; cached for a day, new tables fetched once."""
    f = CACHE / 'source_columns.json'
    with SRC_LOCK:
        have = json.loads(f.read_text()) if f.is_file() else {'at': 0, 'tables': {}}
        if time.time() - have['at'] > 86400:
            have = {'at': time.time(), 'tables': {}}
        missing = [r for r in rels if r not in have['tables'] and r.count('.') == 2]
        by_db = collections.defaultdict(list)
        for r in missing:
            db, rest = r.split('.', 1)
            if re.fullmatch(r'[A-Z0-9_$]+', db):
                by_db[db].append(rest)
        if by_db:
            sql = '\nunion all\n'.join(
                "select upper(table_catalog) || '.' || upper(table_schema) || '.' || upper(table_name) as rel, "
                "upper(column_name) as col, data_type as type, ordinal_position as pos "
                "from %s.information_schema.columns where upper(table_schema) || '.' || upper(table_name) in (%s)"
                % (db, ','.join("'%s'" % t.replace("'", "''") for t in tabs)) for db, tabs in by_db.items())
            for r in sorted(run_show(project, sql), key=lambda r: r['POS']):
                have['tables'].setdefault(r['REL'], {})[r['COL']] = r['TYPE']
            for r in missing:
                have['tables'].setdefault(r, {})  # not found: don't ask again today
            f.write_text(json.dumps(have))
        return {r: have['tables'].get(r) or {} for r in rels}


class Project:
    def __init__(self, path):
        self.path = Path(path)
        self.cache = CACHE / hashlib.sha1(path.encode()).hexdigest()[:12]
        self.manifest = self.cache / 'target' / 'manifest.json'
        self.parsing = False
        self.error = None
        self.failed_src = None
        self.deps_tried = False
        self.data = None
        self.lock = threading.Lock()
        self._dbt = self._ref = None  # ponytail: resolved once per server run; `jordag restart` to re-resolve
        self.cll = self.cll_rev = None
        self.cll_state = {'busy': False, 'step': None, 'progress': '', 'error': None, 'warning': None,
                          'for': None, 'failed_for': None}

    def main_dir(self):
        """Same project inside the repo's main worktree (where venvs and dbt_packages usually live)."""
        top = git(self.path, 'rev-parse', '--show-toplevel')
        common = git(self.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
        return Path(common).parent / os.path.relpath(self.path, top) if top and common else None

    # -- dbt binary: the worktree's venv, then the main worktree's, then PATH
    def dbt(self):
        if self._dbt is None:
            self._dbt = os.environ.get('JORDAG_DBT') or next(
                (str(d / v / 'bin' / 'dbt') for d in (self.path, self.main_dir()) if d
                 for v in ('.venv', 'venv') if (d / v / 'bin' / 'dbt').is_file()), None) or shutil.which('dbt') or ''
        return self._dbt

    def src_mtime(self):
        """Newest mtime across dbt source dirs (dir mtimes catch deletes/renames)."""
        try:
            text = (self.path / 'dbt_project.yml').read_text()
        except OSError:
            return 0
        dirs = {'models', 'macros', 'seeds', 'snapshots', 'tests', 'analyses', 'analysis'}
        # ponytail: regex, not YAML; handles the `model-paths: ["models"]` form dbt init writes
        for m in re.finditer(r'^\s*[\w-]+-paths:\s*\[([^\]]*)\]', text, re.M):
            dirs |= set(re.findall(r'[\w./-]+', m.group(1)))
        newest = 0.0
        for f in ('dbt_project.yml', 'packages.yml', 'dependencies.yml', 'selectors.yml'):
            try:
                newest = max(newest, (self.path / f).stat().st_mtime)
            except OSError:
                pass
        stack = [str(self.path / d) for d in dirs]
        while stack:
            d = stack.pop()
            try:
                newest = max(newest, os.stat(d).st_mtime)
                for e in os.scandir(d):
                    if e.is_dir(follow_symlinks=False):
                        if not e.name.startswith('.'):
                            stack.append(e.path)
                    elif os.path.splitext(e.name)[1] in SRC_EXT:
                        newest = max(newest, e.stat().st_mtime)
            except OSError:
                pass
        return newest

    def manifest_mtime(self):
        try:
            return self.manifest.stat().st_mtime
        except OSError:
            return 0

    def start_parse(self):
        with self.lock:
            if self.parsing:
                return
            self.parsing = True
        threading.Thread(target=self._parse, daemon=True).start()

    def _parse(self):
        src = self.src_mtime()
        try:
            dbt = self.dbt()
            if not dbt:
                self._dbt = None  # look again next time
                raise RuntimeError('No dbt found: expected .venv/bin/dbt or venv/bin/dbt in the worktree, '
                                   'the main worktree, or dbt on PATH (or set JORDAG_DBT).')
            target = self.cache / 'target'
            r = run_dbt(dbt, 'parse', self.path, target)
            if r.returncode and 'dbt deps' in r.output and not self.deps_tried:
                self.deps_tried = True
                run_dbt(dbt, 'deps', self.path, target)
                r = run_dbt(dbt, 'parse', self.path, target)
            if r.returncode:
                raise RuntimeError(tail(r.output) or 'dbt parse failed with exit code %d' % r.returncode)
            if not self.manifest.is_file():
                raise RuntimeError('dbt parse finished but wrote no manifest at %s' % self.manifest)
            # stamp the manifest with the source mtime it reflects, so edits made mid-parse still read as stale
            os.utime(self.manifest, (time.time(), src))
            self.error, self.failed_src = None, None
        except Exception as e:  # surfaced in the UI; the last good manifest stays up
            self.error, self.failed_src = str(e), src
        finally:
            self.parsing = False

    def load(self):
        mt = self.manifest_mtime()
        if not mt:
            return None
        if self.data and self.data['mtime'] == mt:
            return self.data
        m = json.loads(self.manifest.read_bytes())
        full, nodes, fps = {}, [], {}
        for sec in SECTIONS:
            for uid, n in (m.get(sec) or {}).items():
                full[uid] = n
                fps[uid] = fingerprint(n)
                nodes.append(slim(uid, n, fps[uid]))
        prod = {uid: prod_relation(n) for uid, n in full.items()}
        self.data = {'mtime': mt, 'full': full, 'nodes': nodes, 'fps': fps, 'macros': macro_info(m),
                     'prod': {uid: r for uid, r in prod.items() if r},
                     'project': m['metadata'].get('project_name'), 'dbt_version': m['metadata'].get('dbt_version'),
                     'adapter': m['metadata'].get('adapter_type') or ''}
        with LOCK:
            LOADED[str(self.path)] = self
            LOADED.move_to_end(str(self.path))
            while len(LOADED) > 4:
                LOADED.popitem(last=False)[1].data = None
        return self.data

    # -- base = merge-base of HEAD with the remote default branch, parsed once and cached as fingerprints
    def base_ref(self):
        if self._ref is None:
            ref = git(self.path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
            self._ref = next((c for c in ([ref] if ref else []) + ['origin/main', 'origin/master', 'main', 'master']
                              if git(self.path, 'rev-parse', '--verify', '--quiet', c)), '')
        return self._ref

    def base(self):
        ref = self.base_ref()
        sha = ref and git(self.path, 'merge-base', 'HEAD', ref)
        if not sha:
            return None
        dbt = self.dbt()
        key = '%s-%s' % (sha[:12], hashlib.sha1(('%s:%d' % (os.path.realpath(dbt), FP_VERSION)).encode()).hexdigest()[:6])
        with LOCK:
            b = BASES.get(key)
            if b and b['status'] == 'error' and time.time() - b['at'] > 60:
                b = None  # retry failed base builds once a minute
            if b is None:
                f = CACHE / 'base' / key / 'fp.json'
                if f.is_file():
                    b = BASES[key] = dict(json.loads(f.read_text()), status='ready')
                elif dbt:
                    b = BASES[key] = {'status': 'building'}
                    threading.Thread(target=self._build_base, args=(key, sha, dbt), daemon=True).start()
                else:
                    b = {'status': 'error', 'error': 'no dbt', 'at': time.time()}
        return dict(b, ref=ref, sha=sha, key=key)

    def _build_base(self, key, sha, dbt):
        d = CACHE / 'base' / key
        src = d / 'src'
        try:
            shutil.rmtree(src, ignore_errors=True)
            src.mkdir(parents=True)
            top = git(self.path, 'rev-parse', '--show-toplevel')
            a = subprocess.Popen(['git', '-C', top, 'archive', sha], stdout=subprocess.PIPE)
            subprocess.run(['tar', '-x', '-C', str(src)], stdin=a.stdout, check=True, capture_output=True)
            a.stdout.close()
            a.wait()
            proj = src / os.path.relpath(self.path, top)
            pkgs = next((p / 'dbt_packages' for p in (self.path, self.main_dir()) if p and (p / 'dbt_packages').is_dir()), None)
            if pkgs:
                (proj / 'dbt_packages').symlink_to(pkgs)
            r = run_dbt(dbt, 'parse', proj, d / 'target')
            if r.returncode:
                raise RuntimeError(tail(r.output))
            m = json.loads((d / 'target' / 'manifest.json').read_bytes())
            fp = {uid: fingerprint(n) for sec in SECTIONS for uid, n in (m.get(sec) or {}).items()}
            data = {'nodes': fp, 'macros': {k: v[0] for k, v in macro_info(m).items()}}
            (d / 'fp.json').write_text(json.dumps(data))
            BASES[key] = dict(data, status='ready')
        except Exception as e:
            BASES[key] = {'status': 'error', 'error': str(e), 'at': time.time()}
        finally:
            shutil.rmtree(src, ignore_errors=True)
            shutil.rmtree(d / 'target', ignore_errors=True)
            shutil.rmtree(d / 'logs', ignore_errors=True)

    @staticmethod
    def key(mt, base):
        return '%s|%s|%s' % (mt, base and base['key'], base and base['status'])

    def status(self, auto):
        mt = self.manifest_mtime()
        src = self.src_mtime()
        stale = src > mt
        if stale and not self.parsing and src != self.failed_src and (auto or not mt) and time.time() - src > 1:
            self.start_parse()
        base = self.base()
        return {'key': self.key(mt, base), 'mtime': mt, 'parsing': self.parsing, 'stale': stale,
                'error': self.error, 'base': base and {k: base.get(k) for k in ('ref', 'sha', 'status', 'error')}}

    def graph(self):
        d = self.load()
        base = self.base()
        out = {'key': self.key(d and d['mtime'], base), 'path': str(self.path), 'parsing': self.parsing,
               'error': self.error, 'branch': git(self.path, 'rev-parse', '--abbrev-ref', 'HEAD'),
               'base': base and {k: base.get(k) for k in ('ref', 'sha', 'status', 'error')}, 'nodes': None}
        if not d:
            return out
        states, removed = {}, []
        if base and base['status'] == 'ready':
            bn, bm = base['nodes'], base['macros']
            changed = {k for k, (fp, _) in d['macros'].items() if bm.get(k) != fp}
            grew = True
            while grew:  # a macro is changed if anything it calls changed
                grew = False
                for k, (_, deps) in d['macros'].items():
                    if k not in changed and changed.intersection(deps):
                        changed.add(k)
                        grew = True
            for uid, fp in d['fps'].items():
                if uid not in bn:
                    states[uid] = 'new'
                elif bn[uid] != fp or changed.intersection((d['full'][uid].get('depends_on') or {}).get('macros') or []):
                    states[uid] = 'modified'
            removed = sorted(u for u in bn if u not in d['fps'] and not u.startswith('test.'))
        out.update(project=d['project'], dbt_version=d['dbt_version'], removed=removed,
                   nodes=[dict(n, state=states.get(n['id'])) for n in d['nodes']])
        return out

    # -- usage: ACCESS_HISTORY stats for this project's prod relations (fetched account-wide, shared by all projects)
    def usage(self, force=False):
        d = self.load()
        if d and d['adapter'] != 'snowflake':
            return {'unsupported': 'Usage reads Snowflake ACCESS_HISTORY; this project uses %s.' % (d['adapter'] or 'another adapter')}
        refresh_usage(self, force)
        out = {k: USAGE[k] for k in ('at', 'fetching', 'error', 'pipeline_roles', 'team_users')}
        out.update(days=USAGE_DAYS, consumer_roles=CONSUMER_ROLES + LEGACY_ROLES, legacy_roles=LEGACY_ROLES,
                   team_roles=TEAM_ROLES, nodes={}, prod={}, dashboards={}, metabase=None)
        if d:
            out['prod'] = d['prod']
            out['nodes'] = {uid: USAGE['objects'][rel] for uid, rel in d['prod'].items() if rel in USAGE['objects']}
            for uid, n in d['full'].items():
                m = n.get('resource_type') == 'exposure' and re.match(r'(https?://[^/]+)/dashboard/(\d+)', n.get('url') or '')
                if m:
                    out['metabase'] = m.group(1)
                    out['dashboards'][m.group(2)] = uid
        out['names'] = metabase_names(out['metabase'])
        if not (PROD_DB and PROD_SCHEMA):
            out['hint'] = 'Only sources are covered: set prod_database and prod_schema in %s to include models.' % CONFIG_PATH
        return out

    # -- column lineage: dbt compile into the cache, then cll.py (sqlglot) under the project's venv
    def columns_state(self):
        mt, s = self.manifest_mtime(), self.cll_state
        if self.cll is None and s['for'] is None:
            self._load_cll()
        if mt and not s['busy'] and s['for'] != mt and s['failed_for'] != mt:
            s.update(busy=True, step='compiling', progress='', error=None)
            threading.Thread(target=self._build_cll, args=(mt,), daemon=True).start()
        return s

    def _load_cll(self):
        try:
            data = json.loads((self.cache / 'cll.json').read_bytes())
            built_for = float((self.cache / 'cll.for').read_text())
        except (OSError, ValueError):
            return
        rev = collections.defaultdict(list)
        for uid, m in data['models'].items():
            for col, c in m['cols'].items():
                for pu, pc in c['up']:
                    rev[(pu, pc)].append((uid, col))
        self.cll, self.cll_rev = data, rev
        self.cll_state['for'] = built_for

    def sqlglot_python(self):
        """A python that imports sqlglot: the dbt venv's, the main worktree's, else uv fetches it on the fly."""
        bins = [Path(self.dbt()).parent] + [d / v / 'bin' for d in (self.path, self.main_dir()) if d for v in ('.venv', 'venv')]
        for b in bins:
            py = b / 'python'
            if py.is_file() and subprocess.run([str(py), '-c', 'import sqlglot'], capture_output=True).returncode == 0:
                return [str(py)]
        if shutil.which('uv'):
            return [shutil.which('uv'), 'run', '--no-project', '--with', 'sqlglot', 'python']
        raise RuntimeError('No python with sqlglot: pip install sqlglot into the dbt venv (or install uv)')

    def _build_cll(self, mt):
        s = self.cll_state
        try:
            dbt = Path(self.dbt())
            py = self.sqlglot_python()
            target = self.cache / 'compile' / 'target'
            r = run_dbt(str(dbt), 'compile', self.path, target, '--select', 'resource_type:model resource_type:snapshot')
            if r.returncode:
                raise RuntimeError(tail(r.output))
            s['step'] = 'reading source columns'
            m = json.loads((target / 'manifest.json').read_bytes())
            rels = sorted({rel_key(x.get('relation_name')) for x in m['sources'].values() if x.get('relation_name')})
            adapter = m['metadata'].get('adapter_type') or ''
            try:
                cols, s['warning'] = (source_columns(self, rels) if adapter == 'snowflake' else catalog_columns(self)), None
            except Exception as e:
                cols, s['warning'] = {}, 'source column lookup failed, using yml columns: %s' % str(e)[-300:]
            (self.cache / 'compile' / 'sources.json').write_text(json.dumps(cols))
            s['step'] = 'tracing columns'
            p = subprocess.Popen(py + [str(ENGINE), str(target / 'manifest.json'), str(self.cache / 'compile' / 'sources.json'),
                                  str(self.cache / 'cll.json'), str(self.path), DIALECTS.get(adapter, adapter)],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            log = []
            for line in p.stdout:
                if line.startswith('progress '):
                    s['progress'] = line[9:].strip()
                else:
                    log.append(line)
            if p.wait():
                raise RuntimeError(tail(''.join(log)) or 'cll.py failed')
            (self.cache / 'cll.for').write_text(repr(mt))
            self._load_cll()
            s['failed_for'] = None
        except Exception as e:
            s.update(error=str(e), failed_for=mt)
        finally:
            s.update(busy=False, step=None)

    def columns(self, uid, col, direction='both'):
        s = self.columns_state()
        out = {'status': 'ready' if self.cll else 'error' if s['error'] else 'building', 'step': s['step'],
               'progress': s['progress'], 'error': s['error'], 'warning': s['warning'],
               'stale': bool(self.cll) and s['for'] != self.manifest_mtime()}
        if not self.cll or not uid:
            return out
        models, extra = self.cll['models'], dict(self.cll.get('seeds') or {}, **self.cll['sources'])
        if not col:  # this node's columns, for the picker
            m = models.get(uid)
            out['columns'] = [{'col': c, 'up': len(m['cols'][c]['up']) if m else 0, 'down': len(self.cll_rev.get((uid, c), ()))}
                              for c in (m['order'] if m else list(extra.get(uid) or []))]
            return out
        start = (uid, col.upper())
        seen, edges, truncated = {start}, set(), False
        steps = [(lambda k: [tuple(x) for x in ((models.get(k[0]) or {}).get('cols') or {}).get(k[1], {}).get('up', [])], False),
                 (lambda k: self.cll_rev.get(k, []), True)]
        for adj, forward in steps:
            if direction == ('down' if not forward else 'up'):
                continue
            frontier = [start]
            while frontier:
                nxt = []
                for k in frontier:
                    for o in adj(k):
                        o = tuple(o)
                        if o not in seen:
                            if len(seen) >= 600:  # ponytail: hard cap keeps the view legible; narrow with up/down
                                truncated = True
                                continue
                            seen.add(o)
                            nxt.append(o)
                        edges.add((k, o) if forward else (o, k))
                frontier = nxt
        d = self.load()

        def info(k):
            e = ((models.get(k[0]) or {}).get('cols') or {}).get(k[1]) or {}
            docs = ((d['full'].get(k[0]) or {}).get('columns') or {}) if d else {}
            desc = next((v.get('description') for n, v in docs.items() if n.upper() == k[1]), '')
            src = extra.get(k[0])
            return {'id': k[0], 'col': k[1], 'expr': e.get('expr'), 't': e.get('t'), 'desc': desc or '', 'nup': len(e.get('up') or ()),
                    'type': src.get(k[1]) if isinstance(src, dict) else None}

        known = models.get(uid, {}).get('cols') or extra.get(uid) or {}
        out.update(focus=list(start), truncated=truncated, missing=start[1] not in known, nodes=[info(k) for k in seen],
                   edges=[['%s|%s' % a, '%s|%s' % b] for a, b in edges if a in seen and b in seen])
        return out

    def node(self, uid):
        d = self.load()
        n = d and d['full'].get(uid)
        if not n:
            return {'error': 'unknown node'}
        out = dict(n)
        out.pop('compiled_code', None)
        f = self.path / 'target' / 'compiled' / n.get('package_name', '') / (n.get('original_file_path') or '')
        if f.suffix in ('.sql', '.py') and f.is_file():
            out['compiled_code'] = f.read_text(errors='replace')
            out['compiled_mtime'] = f.stat().st_mtime
        out['abs_path'] = str(self.path / (n.get('original_file_path') or ''))
        return out


# ---------------------------------------------------------------- http

TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
         '.svg': 'image/svg+xml'}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body, separators=(',', ':')).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def route(self, method):
        # localhost only: reject DNS-rebinding hosts; POSTs need a custom header (forces a CORS preflight)
        if (self.headers.get('Host') or '').rsplit(':', 1)[0] not in ('127.0.0.1', 'localhost'):
            return self.send(403, {'error': 'bad host'})
        if method == 'POST' and self.headers.get('X-Jordag') != '1':
            return self.send(403, {'error': 'missing header'})
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        try:
            if u.path == '/api/ping':
                return self.send(200, {'ok': True, 'pid': os.getpid(), 'home': str(HERE)})
            if u.path == '/api/projects':
                return self.send(200, find_projects())
            if u.path == '/api/quit' and method == 'POST':
                self.send(200, {'ok': True})
                return threading.Thread(target=self.server.shutdown, daemon=True).start()
            if u.path.startswith('/api/'):
                p = get_project(q.get('p'))
                if not p:
                    return self.send(404, {'error': 'not a dbt project: %s' % q.get('p')})
                if u.path == '/api/status':
                    return self.send(200, p.status(q.get('auto') == '1'))
                if u.path == '/api/graph':
                    return self.send(200, p.graph())
                if u.path == '/api/node':
                    return self.send(200, p.node(q.get('id')))
                if u.path == '/api/usage':
                    return self.send(200, p.usage(force=method == 'POST'))
                if u.path == '/api/columns':
                    return self.send(200, p.columns(q.get('id'), q.get('col'), q.get('dir', 'both')))
                if u.path == '/api/parse' and method == 'POST':
                    p.start_parse()
                    return self.send(200, {'ok': True})
                return self.send(404, {'error': 'no such endpoint'})
            f = WEB / (Path(u.path).name or 'index.html')
            if f.is_file() and f.suffix in TYPES:
                return self.send(200, f.read_bytes(), TYPES[f.suffix])
            self.send(404, {'error': 'not found'})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self.send(500, {'error': repr(e)})


def serve():
    CACHE.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    srv.daemon_threads = True
    print('jordag on http://127.0.0.1:%d' % PORT, flush=True)
    srv.serve_forever()


def call(path, method='GET', timeout=0.5):
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (PORT, path), method=method, headers={'X-Jordag': '1'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


SETUP_HELP = '''usage: jordag setup [--bin DIR] [--skills DIR] [--no-skills]
       jordag setup --sandbox DIR

  Links the `jordag` command into DIR (default ~/.local/bin) and the agent skills in skills/ into
  DIR (default ~/.claude/skills). Never overwrites anything that isn't already a link to this checkout.

  --sandbox DIR runs this checkout beside another jordag: it picks a free port, keeps its cache and
  config under DIR, links bin/ and skills/ there, and remembers all that in .jordag-local.json
  (delete that file to undo). Every way of running this checkout then uses the sandbox.'''


def setup(args):
    if {'-h', '--help'} & set(args):
        return print(SETUP_HELP)
    i = 0
    while i < len(args):
        if args[i] in ('--bin', '--skills', '--sandbox') and i + 1 < len(args):
            i += 2
        elif args[i] == '--no-skills':
            i += 1
        else:
            sys.exit('jordag setup: unexpected argument %r\n\n%s' % (args[i], SETUP_HELP))

    def opt(name, default):
        return Path(args[args.index(name) + 1] if name in args else default).expanduser()

    def link(dst, src):
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.is_symlink() and os.path.realpath(dst) == os.path.realpath(src):
            print('  ok       %s' % dst)
        elif dst.exists() or dst.is_symlink():
            print('  skipped  %s (already exists and is not this checkout)' % dst)
        else:
            dst.symlink_to(src)
            print('  linked   %s -> %s' % (dst, src))

    box = opt('--sandbox', '').resolve() if '--sandbox' in args else None
    if box:
        box.mkdir(parents=True, exist_ok=True)
        if LOCAL and (call('/api/ping') or {}).get('home') == str(HERE):
            call('/api/quit', 'POST')  # re-running: stop this sandbox's server before it moves to a new port
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        LOCAL_FILE.write_text(json.dumps({'port': port, 'cache': str(box / 'cache'), 'config': str(box / 'config.json')}, indent=2))
    bin_dir = box / 'bin' if box else opt('--bin', '~/.local/bin')
    print('jordag setup')
    link(bin_dir / 'jordag', HERE / 'jordag.py')
    if '--no-skills' not in args:
        for d in sorted((HERE / 'skills').iterdir()):
            if (d / 'SKILL.md').is_file():
                link((box / 'skills' if box else opt('--skills', '~/.claude/skills')) / d.name, d)
    for tool, why in (('dbt', 'parsing projects (or keep dbt in a .venv / venv inside each project)'),
                      ('node', '`jordag query` and the agent skills'), ('git', 'worktrees and state:modified')):
        if not shutil.which(tool):
            print('  missing  %s: needed for %s' % (tool, why))
    if box:
        print('\n  sandbox  port %d, cache %s, config %s (optional, may not exist)' % (port, box / 'cache', box / 'config.json'))
        print('           saved in %s; delete it to undo' % LOCAL_FILE)
        print('  next     run this checkout as `python3 %s ...` or `%s ...`.' % (HERE / 'jordag.py', bin_dir / 'jordag'))
        print('           A bare `jordag` on your PATH is another copy; leave it alone.')
        return
    on_path = shutil.which('jordag')
    if str(bin_dir) not in os.environ.get('PATH', '').split(':'):
        print('\n  note: %s is not on your PATH; add it, or run %s directly' % (bin_dir, HERE / 'jordag.py'))
    elif on_path and os.path.realpath(on_path) != os.path.realpath(HERE / 'jordag.py'):
        print('\n  note: `jordag` on your PATH is a different copy (%s); run %s to use this one'
              % (os.path.realpath(on_path), bin_dir / 'jordag'))
    print('\n  config   %s (optional; see %s)' % (CONFIG_PATH, HERE / 'config.example.json'))
    print('  next     cd into a dbt project and run: jordag')


def status():
    pong = call('/api/ping')
    me = os.path.realpath(HERE / 'jordag.py')
    on_path = shutil.which('jordag')
    server = 'not running' if not pong else 'running, this copy' if pong.get('home') == str(HERE) \
        else 'running, ANOTHER copy: %s' % (pong.get('home') or 'an older jordag')
    path = 'not on PATH' if not on_path else 'this copy' if os.path.realpath(on_path) == me \
        else 'ANOTHER copy: %s' % os.path.realpath(on_path)
    for k, v in (('this copy', me), ('sandbox', 'yes (%s)' % LOCAL_FILE if LOCAL else 'no'), ('config', '%s (%s)' % (CONFIG_PATH, 'found' if CONFIG_PATH.is_file() else 'not found, using defaults')),
                 ('cache', CACHE), ('port', PORT), ('server', server), ('on PATH', path)):
        print('  %-10s %s' % (k, v))


def main():
    if sys.argv[1:2] == ['status']:
        return status()
    if sys.argv[1:2] == ['query']:
        if not shutil.which('node'):
            sys.exit('jordag query needs node (https://nodejs.org)')
        os.execvp('node', ['node', str(HERE / 'query.mjs')] + sys.argv[2:])
    if sys.argv[1:2] == ['setup']:
        return setup(sys.argv[2:])
    args = sys.argv[1:]
    flags = {a for a in args if a.startswith('-')}
    args = [a for a in args if not a.startswith('-')]
    if flags & {'-h', '--help'} or args[:1] == ['help']:
        return print(__doc__)
    if args[:1] == ['serve']:
        return serve()
    if args[:1] in (['stop'], ['restart']):
        pong = call('/api/ping')
        if pong and pong.get('home') != str(HERE) and '--force' not in flags:
            sys.stderr.write('jordag: port %d is served by another jordag (%s), so %s left it alone.\n'
                             '  It may be someone\'s running copy. Add --force to %s it anyway.\n'
                             % (PORT, pong.get('home') or 'an older version', args[0], args[0]))
            sys.exit(2)
        running = call('/api/quit', 'POST')
        for _ in range(20):
            if not call('/api/ping'):
                break
            time.sleep(0.1)
        if args[0] == 'stop':
            return print('jordag: %s on port %d' % ('stopped the server' if running else 'no server running', PORT))
        args = args[1:]
    if not call('/api/ping'):
        CACHE.mkdir(parents=True, exist_ok=True)
        log = open(CACHE / 'server.log', 'ab')
        subprocess.Popen([sys.executable, os.path.realpath(__file__), 'serve'], stdout=log, stderr=log,
                         stdin=subprocess.DEVNULL, start_new_session=True)
        for _ in range(50):
            if call('/api/ping'):
                break
            time.sleep(0.1)
        else:
            sys.exit('jordag: server failed to start, see %s' % (CACHE / 'server.log'))
    pong = call('/api/ping') or {}
    if pong.get('home') != str(HERE):
        me = os.path.realpath(HERE / 'jordag.py')
        sys.stderr.write('jordag: port %d is served by another jordag (%s).\n'
                         '  Run this copy beside it:  python3 %s setup --sandbox <new folder>\n'
                         '  Or replace it (it may be someone\'s running copy; ask first):\n'
                         '    python3 %s restart --force\n' % (PORT, pong.get('home') or 'an older version', me, me))
        sys.exit(2)
    here = Path(args[0] if args else '.').resolve()
    proj = next((d for d in [here, *here.parents] if (d / 'dbt_project.yml').is_file()), None)
    url = 'http://127.0.0.1:%d/' % PORT + ('?p=' + urllib.parse.quote(str(proj), safe='') if proj else '')
    print(url)
    if '--print' not in flags:
        webbrowser.open(url)


if __name__ == '__main__':
    main()
