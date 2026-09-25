import { index, select, METHODS } from './selector.js';
import { summarize, panelSection, tableHtml, fmt } from './usage.js';
import { initColumns } from './columns.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const enc = encodeURIComponent;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (path, method = 'GET') =>
  fetch(path, { method, headers: method === 'POST' ? { 'X-Jordag': '1' } : {} }).then(r => r.json());

const COLORS = {
  model: '#5b8def', source: '#34d399', seed: '#a78bfa', snapshot: '#f472b6', exposure: '#fb923c', analysis: '#94a3b8',
  test: '#64748b', unit_test: '#64748b', metric: '#22d3ee', semantic_model: '#2dd4bf', saved_query: '#38bdf8',
};
const ORDER = Object.keys(COLORS);
const color = t => COLORS[t] || '#94a3b8';
const tint = (hex, a) => {
  const n = parseInt(hex.slice(1), 16), bg = [13, 17, 26];
  return `rgb(${[16, 8, 0].map((s, i) => Math.round(((n >> s) & 255) * a + bg[i] * (1 - a))).join(',')})`;
};
const FONT = '-apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif';
const measure = document.createElement('canvas').getContext('2d');
measure.font = `12px ${FONT}`;

const st = {
  p: '', sel: '', exc: '', g: null, key: null, sig: '', focus: null, fps: null, fpsFor: null, dir: 'LR',
  live: localStorage.getItem('jordag.live') !== '0',
  off: new Set(JSON.parse(localStorage.getItem('jordag.off') || '["test","unit_test"]')),
  status: null, projects: [],
  mode: 'graph', win: 30, lens: false, usage: null, ucfg: { sort: 'verdict', desc: false, verdict: '' },
  col: null, colDir: 'both', colModel: null, colSel: null,
};

// ------------------------------------------------------------ graph canvas

cytoscape.use(cytoscapeDagre);
const underlay = c => ({ 'underlay-color': c, 'underlay-opacity': 0.65, 'underlay-padding': 6, 'underlay-shape': 'round-rectangle' });
const cy = cytoscape({
  container: $('#cy'), wheelSensitivity: 0.3, minZoom: 0.03, maxZoom: 2.5, boxSelectionEnabled: false,
  style: [
    { selector: 'node', style: {
      shape: 'round-rectangle', width: 'data(w)', height: 30, 'background-color': 'data(bg)', 'border-width': 1.5,
      'border-color': 'data(color)', label: 'data(label)', color: '#e7ebf3', 'font-size': 12, 'font-family': FONT,
      'text-valign': 'center', 'text-halign': 'center' } },
    { selector: 'node[mat = "table"]', style: { 'border-width': 2.5 } },
    { selector: 'node[mat = "incremental"]', style: { 'border-style': 'double', 'border-width': 4.5 } },
    { selector: 'node[mat = "ephemeral"]', style: { 'border-style': 'dashed' } },
    { selector: 'node.focus', style: { 'font-weight': 700 } },
    { selector: 'node.modified', style: underlay('#facc15') },
    { selector: 'node.new', style: underlay('#4ade80') },
    { selector: 'node.flash', style: { 'underlay-color': '#e879f9', 'underlay-opacity': 0.9, 'underlay-padding': 12, 'underlay-shape': 'round-rectangle' } },
    { selector: 'node.lens', style: { label: 'data(ulabel)', width: 'data(uw)', 'background-color': 'mapData(heat, 0, 1, #141a26, #c2410c)' } },
    { selector: 'node.lens.u-unused', style: { 'border-color': '#f87171', 'border-style': 'dashed', 'border-width': 2.5 } },
    { selector: 'node.lens.u-dormant', style: { 'border-color': '#fb923c', 'border-style': 'dotted', 'border-width': 2.5 } },
    { selector: 'node.lens.u-team', style: { 'border-color': '#c084fc' } },
    { selector: 'node.found', style: { 'border-color': '#ffffff', 'border-width': 3 } },
    { selector: 'node:selected', style: { 'background-color': 'data(color)', color: '#0b0e14', 'border-color': '#ffffff', 'border-width': 2.5 } },
    { selector: 'edge', style: {
      width: 1.2, 'line-color': '#2f3a4f', 'target-arrow-color': '#2f3a4f', 'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8, 'curve-style': 'bezier' } },
    { selector: 'edge.hl', style: { 'line-color': '#8aa8ff', 'target-arrow-color': '#8aa8ff', width: 2, 'z-index': 10 } },
    { selector: '.faded', style: { opacity: 0.1, 'underlay-opacity': 0.06 } },
  ],
});

const label = n => {
  const l = n.type === 'source' ? `${n.source_name}.${n.name}` : n.label || n.name;
  return l.length > 52 ? l.slice(0, 50) + '…' : l;
};
// the selector that picks exactly this node
const selName = n => n.type === 'source' ? `source:${n.source_name}.${n.name}`
  : ['exposure', 'metric', 'semantic_model', 'saved_query'].includes(n.type) ? `${n.type}:${n.name}` : n.name;

function render(relayout) {
  const g = st.g;
  if (!g || st.mode === 'columns') return;
  let res;
  try {
    res = select(g, st.sel, st.exc, { root: g.project });
    $('#err').textContent = '';
  } catch (e) {
    $('#err').textContent = e.message;
    return;
  }
  chips(res.ids);
  const ids = [...res.ids].filter(id => !st.off.has(g.byId.get(id).type));
  if (st.mode === 'usage') return renderUsage(ids);
  const keep = new Set(ids);
  const focus = st.sel.trim() && res.matched.size < ids.length;
  const lens = st.lens && st.usage?.at ? new Map(ids.map(id => [id, summarize(st.usage, g, id, st.win)])) : null;
  const umax = lens ? Math.max(1, ...[...lens.values()].map(s => s.reads)) : 1;
  const els = [];
  for (const id of ids) {
    const n = g.byId.get(id), l = label(n), c = color(n.type), u = lens?.get(id);
    const data = { id, label: l, w: Math.ceil(measure.measureText(l).width) + 26, color: c, bg: tint(c, 0.17), mat: n.config.materialized || '' };
    if (u?.verdict) Object.assign(data, { ulabel: `${l} · ${fmt(u.reads)}`, uw: Math.ceil(measure.measureText(`${l} · ${fmt(u.reads)}`).width) + 26, heat: Math.log1p(u.reads) / Math.log1p(umax) });
    els.push({ group: 'nodes', data, classes: [n.state, focus && res.matched.has(id) && 'focus', u?.verdict && `lens u-${u.verdict}`].filter(Boolean).join(' ') });
  }
  for (const id of ids) for (const p of g.parents.get(id)) if (keep.has(p)) els.push({ group: 'edges', data: { id: `${p}>${id}`, source: p, target: id } });
  const sig = st.dir + (lens ? 'L' : '') + els.map(e => e.data.id).join('|');
  if (sig === st.sig && !relayout) {
    cy.batch(() => els.forEach(e => e.group === 'nodes' && cy.getElementById(e.data.id).data(e.data).classes(e.classes)));
  } else {
    st.sig = sig;
    cy.batch(() => { cy.elements().remove(); cy.add(els); });
    layout();
  }
  highlight(st.focus && cy.getElementById(st.focus));
  const nodes = els.filter(e => e.group === 'nodes').length;
  empty(nodes ? '' : st.sel || st.exc ? `No nodes match <code>${esc(st.sel)}</code>${st.exc ? ` minus <code>${esc(st.exc)}</code>` : ''}` : 'Nothing to show: every resource type is toggled off');
  stats(nodes, els.length - nodes);
}

function layout() {
  const n = cy.nodes().length;
  cy.layout({ name: 'dagre', rankDir: st.dir, nodeSep: 10, rankSep: n > 300 ? 60 : 90, edgeSep: 6,
    ranker: n > 400 ? 'longest-path' : 'network-simplex', fit: true, padding: 40, animate: false }).run();
  if (cy.zoom() > 1.2) { cy.zoom(1.2); cy.center(); }
}

function highlight(node) {
  cy.batch(() => {
    cy.elements().removeClass('faded hl');
    if (!node || node.empty() || !node.inside()) return;
    const lin = node.predecessors().union(node.successors()).union(node);
    cy.elements().difference(lin).addClass('faded');
    lin.edges().addClass('hl');
  });
}

function flash(ids) {
  const els = cy.collection(ids.map(id => cy.getElementById(id)).filter(e => e.nonempty()));
  els.addClass('flash');
  setTimeout(() => els.removeClass('flash'), 2500);
}

cy.on('mouseover', 'node', e => highlight(e.target));
cy.on('mouseout', 'node', () => highlight(st.focus && cy.getElementById(st.focus)));
cy.on('tap', 'node', e => openPanel(e.target.id()));
cy.on('tap', e => { if (e.target === cy) closePanel(); });
cy.on('dbltap', 'node', e => setSel(`+${selName(st.g.byId.get(e.target.id()))}+`));

// ------------------------------------------------------------ usage: table view, lens, loading

function renderUsage(ids) {
  $('#usage-view').innerHTML = tableHtml(st.usage, st.g, ids, { ...st.ucfg, win: st.win, focus: st.focus }, { esc, color, label });
  if (!st.usage) loadUsage();
}

async function loadUsage(force) {
  clearTimeout(st.utimer);
  const p = st.p;
  const u = await api(`/api/usage?p=${enc(p)}`, force ? 'POST' : 'GET').catch(() => null);
  if (!u || p !== st.p) return;
  st.usage = u;
  if (st.mode === 'usage' || st.lens) render();
  if (st.focus && !$('#panel').hidden && st.mode !== 'columns') openPanel(st.focus);
  if (u.fetching) st.utimer = setTimeout(loadUsage, 4000);
}

$('#usage-view').addEventListener('click', e => {
  const b = e.target.closest('[data-win],[data-verdict],[data-sort],[data-refresh],tr[data-id]');
  if (!b) return;
  const d = b.dataset;
  if (d.win) st.win = +d.win;
  else if (d.verdict !== undefined) st.ucfg.verdict = d.verdict;
  else if (d.sort) st.ucfg = { ...st.ucfg, desc: st.ucfg.sort === d.sort ? !st.ucfg.desc : d.sort !== 'name', sort: d.sort };
  else if (d.refresh !== undefined) return loadUsage(true);
  else if (d.id) return openPanel(d.id).then(() => render());
  writeUrl(false);
  render();
});
$('#usage-view').addEventListener('dblclick', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) { setMode('graph'); openPanel(tr.dataset.id); }
});

$('#lens').onclick = () => {
  st.lens = !st.lens;
  $('#lens').classList.toggle('on', st.lens);
  document.body.classList.toggle('lens', st.lens);
  if (st.lens && !st.usage) loadUsage();
  writeUrl(false);
  render();
};

// ------------------------------------------------------------ modes

const cols = initColumns({ st, $, api, esc, enc, color, tint, label, hl, writeUrl: push => writeUrl(push),
  showPanel, closePanel: () => closePanel(), openModel: id => { setMode('graph'); openPanel(id); } });

function setMode(m, push = true) {
  if (m === st.mode) return;
  const prev = st.mode, model = st.focus;
  if (prev === 'columns' || m === 'columns') closePanel();
  st.mode = document.body.dataset.mode = m;
  for (const b of $$('#modes button')) b.classList.toggle('on', b.dataset.mode === m);
  if (prev === 'columns') cols.leave();
  writeUrl(push);
  if (m === 'columns') return cols.enter(model);
  if (m === 'usage' && !st.usage) loadUsage();
  cy.resize();
  render();
}

$('#modes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });

// ------------------------------------------------------------ chrome: chips, stats, status

function chips(ids) {
  const counts = {};
  for (const id of ids) { const t = st.g.byId.get(id).type; counts[t] = (counts[t] || 0) + 1; }
  for (const n of st.g.nodes) counts[n.type] ||= 0;
  const changed = st.g.nodes.filter(n => n.state && n.type !== 'test').length;
  $('#types').innerHTML = Object.keys(counts).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    .map(t => `<button class="chip ${st.off.has(t) ? 'off' : ''}" data-type="${t}" style="--c:${color(t)}" title="show/hide ${t}s"><i></i>${t.replace('_', ' ')} <b>${counts[t]}</b></button>`)
    .join(' ') + (changed ? ` <button class="chip changes" data-changes title="1+state:modified+ (changes vs base, their parents, and everything downstream)"><i></i>${changed} changed</button>` : '');
}

$('#types').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.changes !== undefined) return setSel('1+state:modified+');
  const t = b.dataset.type;
  st.off.has(t) ? st.off.delete(t) : st.off.add(t);
  localStorage.setItem('jordag.off', JSON.stringify([...st.off]));
  render(true);
});

function stats(nodes, edges) {
  const g = st.g, b = g.base;
  const base = !b ? 'no git base' : b.status === 'building' ? `diffing vs ${esc(b.ref)}…`
    : b.status === 'error' ? `<a data-log="base">diff vs ${esc(b.ref)} failed</a>` : `vs ${esc(b.ref)} @ ${b.sha.slice(0, 7)}`;
  const removed = g.removed?.length ? ` · <a title="${esc(g.removed.join('\n'))}">${g.removed.length} removed</a>` : '';
  $('#stats').innerHTML = `<span>${nodes} nodes · ${edges} edges</span><span>${base}${removed}</span><span>dbt ${esc(g.dbt)}</span>`;
}

$('#stats').addEventListener('click', e => { if (e.target.dataset.log) showLog('Base diff failed', st.g.base.error); });

function empty(html) {
  $('#empty').hidden = !html;
  $('#empty').innerHTML = html;
}

function showStatus(s) {
  st.status = s;
  let cls, txt;
  if (!s) [cls, txt] = ['err', 'server offline'];
  else if (s.parsing) [cls, txt] = ['busy', 'parsing…'];
  else if (s.error) [cls, txt] = ['err', 'parse error'];
  else if (s.stale) [cls, txt] = ['stale', st.live ? 'change detected…' : 'stale · ↻ to refresh'];
  else [cls, txt] = st.live ? ['ok', 'live'] : ['', 'paused'];
  const pill = $('#status');
  pill.className = 'pill ' + cls;
  pill.querySelector('span').textContent = txt;
  pill.title = (s?.error ? 'click for the dbt output' : `click to ${st.live ? 'pause' : 'resume'} re-parsing on file changes`)
    + (s?.mtime ? `\nmanifest reflects files as of ${new Date(s.mtime * 1000).toLocaleString()}` : '');
}

function showLog(title, text) {
  $('#log-title').textContent = title;
  $('#log pre').textContent = text || '(no output)';
  $('#log').showModal();
}

$('#status').onclick = () => {
  if (st.status?.error) return showLog('dbt parse error (showing last good manifest)', st.status.error);
  st.live = !st.live;
  localStorage.setItem('jordag.live', st.live ? '1' : '0');
  poll();
};
$('#reparse').onclick = async e => { e.stopPropagation(); await api(`/api/parse?p=${enc(st.p)}`, 'POST'); poll(); };

// --exclude stays folded behind "+ exclude" until it's used
function syncExc() {
  const open = !!(st.exc || $('#exc').value || document.activeElement === $('#exc'));
  $('.field.exc').hidden = !open;
  $('#excbtn').hidden = open;
}
$('#excbtn').onclick = e => { e.preventDefault(); $('.field.exc').hidden = false; $('#excbtn').hidden = true; $('#exc').focus(); };
$('#exc').addEventListener('blur', () => setTimeout(syncExc, 200));

// ------------------------------------------------------------ details panel

const kv = (k, v, copy) => `<div class="kv"><span>${k}</span><code>${esc(v)}</code>${copy ? `<button data-copy="${esc(copy)}" title="copy">copy</button>` : '<i></i>'}</div>`;

function nodeList(title, ids, open = true) {
  if (!ids.length) return '';
  const g = st.g;
  return `<details ${open ? 'open' : ''}><summary>${title}<span>${ids.length}</span></summary><ul>${ids.map(id => {
    const n = g.byId.get(id);
    return `<li><a data-go="${esc(id)}"><i style="background:${color(n.type)}"></i>${esc(label(n))}${n.state ? `<span class="badge ${n.state}">${n.state}</span>` : ''}</a></li>`;
  }).join('')}</ul></details>`;
}

const KW = 'select|from|where|join|left|right|inner|outer|full|cross|on|and|or|not|as|with|group|by|order|having|union|all|case|when|then|else|end|distinct|limit|qualify|over|partition|is|null|in|like|ilike|between|cast|true|false|using|lateral|rows|range|asc|desc|exists|interval|except|intersect|window|recursive|if|coalesce|nullif|iff';
const TOK = new RegExp(String.raw`(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\})|(--[^\n]*|/\*[\s\S]*?\*/)|('(?:[^'\\]|\\.)*')|\b(${KW})\b|\b(\d+(?:\.\d+)?)\b`, 'gi');
function hl(code) {
  let out = '', last = 0;
  for (const m of code.matchAll(TOK)) {
    out += esc(code.slice(last, m.index));
    out += `<span class="${m[1] ? 'jj' : m[2] ? 'cm' : m[3] ? 'str' : m[4] ? 'kw' : 'num'}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

const ago = t => {
  const s = Date.now() / 1000 - t;
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

function panelHtml(n, d) {
  const g = st.g, sn = selName(n), kids = g.children.get(n.id);
  const isTest = id => ['test', 'unit_test'].includes(g.byId.get(id).type);
  const cols = Object.values(d?.columns || {});
  const owner = d?.owner && [d.owner.name, d.owner.email].filter(Boolean).join(' · ');
  return `
    <div class="ph">
      <span class="badge" style="--c:${color(n.type)}">${n.type.replace('_', ' ')}</span>
      ${n.config.materialized ? `<span class="badge">${esc(n.config.materialized)}</span>` : ''}
      ${n.state ? `<span class="badge ${n.state}">${n.state}</span>` : ''}
      <button class="x" data-act="close" title="close (esc)">✕</button>
    </div>
    <h2>${esc(label(n))}</h2>
    ${kv('id', n.id)}
    ${d?.relation_name ? kv('relation', d.relation_name, d.relation_name) : ''}
    ${n.path ? kv('file', n.path, d?.abs_path || n.path) : ''}
    ${owner ? kv('owner', owner) : ''}
    ${d?.url ? `<div class="kv"><span>url</span><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a><i></i></div>` : ''}
    <div class="actions">
      <button class="primary" data-sel="+${esc(sn)}+" title="+${esc(sn)}+">Lineage</button>
      <button data-sel="+${esc(sn)}" title="+${esc(sn)}">Upstream</button>
      <button data-sel="${esc(sn)}+" title="${esc(sn)}+">Downstream</button>
      <button data-sel="@${esc(sn)}" title="@${esc(sn)}">@ build set</button>
      <button data-add="${esc(sn)}" title="add ${esc(sn)} to --select">+ add</button>
      <button data-exc="${esc(sn)}" title="add ${esc(sn)} to --exclude">− exclude</button>
      <button data-copy="${esc(sn)}" title="copy selector">copy</button>
      ${['model', 'source', 'seed', 'snapshot'].includes(n.type) ? '<button data-act="columns" title="column-level lineage for this node (c)">Columns ⇢</button>' : ''}
    </div>
    ${d?.description ? `<p class="desc">${esc(d.description)}</p>` : d ? '' : '<p class="desc note">loading…</p>'}
    ${n.tags.length ? `<div class="tags">${n.tags.map(t => `<button class="tag" data-sel="tag:${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
    ${panelSection(st.usage, g, n.id, st.win, esc)}
    ${nodeList('Upstream', g.parents.get(n.id))}
    ${nodeList('Downstream', kids.filter(id => !isTest(id)))}
    ${nodeList('Tests', kids.filter(isTest), false)}
    ${cols.length ? `<details open><summary>Columns<span>${cols.length} documented · click to trace</span></summary><table class="cols">${cols.map(c =>
      `<tr data-tracecol="${esc(c.name)}" title="trace ${esc(c.name)} through the DAG"><td>${esc(c.name)}</td><td class="t">${esc(c.data_type || '')}</td><td>${esc(c.description || '')}</td></tr>`).join('')}</table></details>` : ''}
    ${d?.raw_code ? `<details open><summary>Source</summary><pre class="code">${hl(d.raw_code)}</pre></details>` : ''}
    ${d?.compiled_code ? `<details><summary>Compiled <span class="note">from target/compiled, ${ago(d.compiled_mtime)}</span></summary><pre class="code">${hl(d.compiled_code)}</pre></details>` : ''}`;
}

function showPanel(html) {
  const panel = $('#panel');
  panel.hidden = false;
  panel.dataset.id = '';
  panel.innerHTML = html;
  document.body.classList.add('panel-open');
}

async function openPanel(id) {
  const n = st.g?.byId.get(id);
  if (!n || st.mode === 'columns') return;
  if (!st.usage) loadUsage();
  st.focus = id;
  cy.$(':selected').unselect();
  const el = cy.getElementById(id);
  highlight(el);
  const panel = $('#panel');
  const same = !panel.hidden && panel.dataset.id === id;
  panel.hidden = false;
  panel.dataset.id = id;
  document.body.classList.add('panel-open');
  cy.resize();
  if (el.nonempty()) {
    el.select();
    const { x, y } = el.renderedPosition();
    if (x < 30 || x > cy.width() - 30 || y < 30 || y > cy.height() - 30) cy.animate({ center: { eles: el }, duration: 250 });
  }
  if (!same) { panel.innerHTML = panelHtml(n, null); panel.scrollTop = 0; writeUrl(false); }
  const d = await api(`/api/node?p=${enc(st.p)}&id=${enc(id)}`);
  if (st.focus !== id) return;
  const scroll = panel.scrollTop;
  panel.innerHTML = panelHtml(n, d);
  panel.scrollTop = scroll;
}

function closePanel() {
  if (st.focus) { st.focus = null; writeUrl(false); }
  st.colSel = null;
  $('#panel').hidden = true;
  document.body.classList.remove('panel-open');
  cy.resize();
  cols?.resize();
  cy.$(':selected').unselect();
  highlight(null);
}

function go(id) {
  const el = cy.getElementById(id);
  if (el.nonempty()) cy.animate({ center: { eles: el }, duration: 250 });
  openPanel(id);
}

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const was = btn.textContent;
  btn.textContent = 'copied ✓';
  setTimeout(() => { btn.textContent = was; }, 1200);
}

$('#panel').addEventListener('click', e => {
  const b = e.target.closest('[data-sel],[data-add],[data-exc],[data-go],[data-act],[data-copy],[data-win],[data-tracecol]');
  if (!b) return;
  const d = b.dataset, join = (a, x) => a.trim() ? `${a.trim()} ${x}` : x;
  if (d.win) { e.preventDefault(); st.win = +d.win; writeUrl(false); render(st.lens); openPanel(st.focus); }
  else if (d.tracecol) { const id = st.focus; setMode('columns'); cols.focus(id, d.tracecol.toUpperCase()); }
  else if (d.act === 'columns') setMode('columns');
  else if (d.sel) setSel(d.sel);
  else if (d.add) setSel(join(st.sel, d.add));
  else if (d.exc) { st.exc = $('#exc').value = join(st.exc, d.exc); applied(); }
  else if (d.go) go(d.go);
  else if (d.copy) copy(d.copy, b);
  else if (d.act === 'close') closePanel();
});

// ------------------------------------------------------------ selection input, autocomplete, url state

function setSel(s) {
  st.sel = $('#sel').value = s;
  applied();
}

function applied() {
  syncExc();
  remember(st.sel);
  writeUrl(true);
  render(true);
}

$('#q').addEventListener('submit', e => {
  e.preventDefault();
  st.sel = $('#sel').value.trim();
  st.exc = $('#exc').value.trim();
  document.activeElement.blur();
  applied();
});

const recent = () => JSON.parse(localStorage.getItem('jordag.recent') || '[]');
function remember(s) {
  if (s) localStorage.setItem('jordag.recent', JSON.stringify([s, ...recent().filter(x => x !== s)].slice(0, 12)));
}
const PRESETS = ['1+state:modified+', 'state:modified+', '+state:modified+', 'resource_type:exposure', 'config.materialized:table'];

function values(g, method) {
  const uniq = xs => [...new Set(xs.filter(Boolean))].sort();
  const ofType = t => g.nodes.filter(n => n.type === t).map(n => n.name);
  if (method === 'tag') return uniq(g.nodes.flatMap(n => n.tags));
  if (method === 'source') return uniq(g.nodes.filter(n => n.type === 'source').flatMap(n => [n.source_name, `${n.source_name}.${n.name}`]));
  if (method === 'path') return uniq(g.nodes.flatMap(n => (n.path || '').split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
  if (method === 'file') return uniq(g.nodes.map(n => (n.path || '').split('/').pop()));
  if (method === 'resource_type') return uniq(g.nodes.map(n => n.type));
  if (method === 'package') return uniq(g.nodes.map(n => n.pkg));
  if (method === 'state') return ['modified', 'new', 'unmodified'];
  if (method === 'test_type') return ['generic', 'singular', 'unit'];
  if (method === 'test_name') return uniq(g.nodes.map(n => n.test_name));
  if (method.startsWith('config.')) return uniq(g.nodes.flatMap(n => [n.config[method.slice(7)]].flat().map(v => v == null ? '' : String(v))));
  if (method === 'group' || method === 'access') return uniq(g.nodes.map(n => n.config[method]));
  return ofType(method);
}

function suggest(input, list) {
  const g = st.g, v = input.value;
  if (!g) return;
  if (!v.trim()) {
    list.innerHTML = [...new Set([...recent(), ...PRESETS])].map(c => `<option value="${esc(c)}">`).join('');
    return;
  }
  const [, pre = '', op = '', tok = ''] = /^(.*[\s,])?(@|\d*\+)?([^\s,]*)$/.exec(v) || [];
  const i = tok.indexOf(':');
  const cands = i < 0
    ? [...Object.keys(METHODS).filter(k => k !== 'fqn').map(k => k + ':'), 'config.materialized:',
       ...(g.names ||= [...new Set(g.nodes.filter(n => n.type !== 'test').flatMap(n => [selName(n),
         // fqn folder prefixes (marts, marts.finance, ...) for models/seeds/snapshots
         ...(['model', 'seed', 'snapshot'].includes(n.type) ? n.fqn.slice(1, -1).map((_, i, a) => a.slice(0, i + 1).join('.')) : [])]))].sort())]
    : values(g, tok.slice(0, i)).map(x => tok.slice(0, i + 1) + x);
  const t = tok.toLowerCase();
  const hits = cands.filter(c => c.toLowerCase().startsWith(t) && c !== tok).slice(0, 60);
  list.innerHTML = hits.map(c => `<option value="${esc(pre + op + c)}">`).join('');
}
for (const [inp, list] of [['#sel', '#sel-list'], ['#exc', '#exc-list']]) {
  $(inp).addEventListener('input', () => suggest($(inp), $(list)));
  $(inp).addEventListener('focus', () => suggest($(inp), $(list)));
}

function writeUrl(push) {
  const u = new URLSearchParams();
  if (st.p) u.set('p', st.p);
  if (st.sel) u.set('s', st.sel);
  if (st.exc) u.set('x', st.exc);
  if (st.focus) u.set('n', st.focus);
  if (st.mode !== 'graph') u.set('m', st.mode);
  if (st.lens) u.set('l', '1');
  if (st.mode === 'usage' && st.ucfg.verdict) u.set('v', st.ucfg.verdict);
  if (st.win !== 30) u.set('w', st.win);
  if (st.mode === 'columns' && st.col) u.set('c', `${st.col.id}|${st.col.col}`);
  if (st.mode === 'columns' && st.colDir !== 'both') u.set('cd', st.colDir);
  const url = '?' + u.toString().replace(/%2F/g, '/');
  if (url !== location.search) history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function readUrl() {
  const u = new URLSearchParams(location.search);
  st.p = u.get('p') || st.p;
  st.sel = $('#sel').value = u.get('s') || '';
  st.exc = $('#exc').value = u.get('x') || '';
  syncExc();
  st.focus = u.get('n') || null;
  const c = u.get('c'), i = c ? c.lastIndexOf('|') : -1;
  st.col = i > 0 ? { id: c.slice(0, i), col: c.slice(i + 1).toUpperCase() } : null;
  st.colDir = u.get('cd') || 'both';
  st.lens = u.get('l') === '1';
  st.ucfg.verdict = u.get('v') || '';
  st.win = [7, 30, 90].includes(+u.get('w')) ? +u.get('w') : 30;
  $('#lens').classList.toggle('on', st.lens);
  document.body.classList.toggle('lens', st.lens);
  return u.get('m') || 'graph';
}

window.addEventListener('popstate', () => {
  const p = st.p, m = readUrl();
  if (m !== st.mode) setMode(m, false);
  if (st.p !== p) switchProject(st.p, false);
  else if (st.mode === 'columns') cols.refresh();
  else { render(true); st.focus ? openPanel(st.focus) : closePanel(); }
});

// ------------------------------------------------------------ projects, loading, live polling

async function loadProjects() {
  const list = await api('/api/projects');
  if (st.p && !list.some(x => x.path === st.p)) list.push({ path: st.p, repo: 'other', name: st.p.split('/').pop(), branch: '' });
  st.projects = list;
  const groups = {};
  for (const x of list) (groups[x.repo] ||= []).push(x);
  const html = Object.entries(groups).map(([repo, xs]) => `<optgroup label="${esc(repo)}">${xs.map(x =>
    `<option value="${esc(x.path)}">${esc(x.name)}${x.branch ? '  ·  ' + esc(x.branch) : ''}</option>`).join('')}</optgroup>`).join('');
  if (html !== st.projectsHtml) { $('#project').innerHTML = st.projectsHtml = html; }
  if (!st.p) st.p = list.find(x => x.path === localStorage.getItem('jordag.p'))?.path || list[0]?.path || '';
  $('#project').value = st.p;
  if (!list.length) empty(`No dbt projects found. Run <code>jordag</code> from inside a dbt project, or set <code>JORDAG_ROOTS</code>.`);
}

$('#project').onchange = e => switchProject(e.target.value, true);

function switchProject(p, push) {
  if (push) closePanel();
  st.p = p;
  st.g = null; st.key = null; st.sig = ''; st.usage = null;
  cy.elements().remove();
  $('#project').value = p;
  writeUrl(push);
  poll();
}

async function loadGraph() {
  const p = st.p;
  const d = await api(`/api/graph?p=${enc(p)}`);
  if (p !== st.p) return;
  st.key = d.key;
  const proj = st.projects.find(x => x.path === p);
  localStorage.setItem('jordag.p', p);
  document.title = `${proj?.name || p.split('/').pop()}${d.branch ? ' · ' + d.branch : ''} · jordag`;
  if (!d.nodes) {
    st.g = null; st.sig = '';
    cy.elements().remove();
    $('#types').innerHTML = $('#stats').innerHTML = '';
    return empty(d.error ? 'Parse failed. Click the red status pill for the dbt output.'
      : `<div class="spin"></div>Parsing <code>${esc(proj?.name || p)}</code>…<br><small>first parse of a worktree takes ~10s, then it's incremental</small>`);
  }
  const g = Object.assign(index(d.nodes), { project: d.project, base: d.base, removed: d.removed, dbt: d.dbt_version });
  const changed = st.fpsFor === p ? d.nodes.filter(n => st.fps.get(n.id) !== n.fp).map(n => n.id) : [];
  st.fps = new Map(d.nodes.map(n => [n.id, n.fp]));
  st.fpsFor = p;
  st.g = g;
  placeholder(g);
  if (st.focus && g.byId.has(st.focus) && $('#panel').hidden) { document.body.classList.add('panel-open'); cy.resize(); }
  render();
  if (st.mode === 'columns') cols.refresh();
  if ((st.lens || st.mode === 'usage') && !st.usage) loadUsage();
  if (changed.length && changed.length < 60) flash(changed);
  if (st.focus && g.byId.has(st.focus)) openPanel(st.focus);
  else if (st.focus) closePanel();
}

// example selectors from this project: its most-referenced model and most common tag
function placeholder(g) {
  const kids = n => g.children.get(n.id).filter(id => g.byId.get(id).type !== 'test').length;
  const hub = g.nodes.filter(n => n.type === 'model').sort((a, b) => kids(b) - kids(a))[0];
  const tags = {};
  for (const n of g.nodes) for (const t of n.tags) tags[t] = (tags[t] || 0) + 1;
  const tag = Object.keys(tags).sort((a, b) => tags[b] - tags[a])[0];
  $('#sel').placeholder = [hub && `+${hub.name}+`, tag && `tag:${tag}`, 'state:modified+'].filter(Boolean).join('  ') + '   ( / )';
}

async function poll() {
  clearTimeout(st.timer);
  const p = st.p;
  if (p) {
    try {
      const s = await api(`/api/status?p=${enc(p)}&auto=${st.live ? 1 : 0}`);
      if (p === st.p) {
        showStatus(s);
        if (s.key !== st.key) await loadGraph();
      }
    } catch {
      showStatus(null);
    }
  }
  st.timer = setTimeout(poll, document.hidden ? 5000 : 1500);
}

// ------------------------------------------------------------ tools + keys

const fit = () => st.mode === 'columns' ? cols.fit() : cy.animate({ fit: { eles: cy.elements(), padding: 40 }, duration: 200 });
$('#fit').onclick = fit;
$('#dir').onclick = () => { st.dir = st.dir === 'LR' ? 'TB' : 'LR'; $('#dir').textContent = st.dir === 'LR' ? '⇄ LR' : '⇅ TB'; render(true); };
$('#cmd').onclick = e => {
  const q = s => `'${s}'`;
  copy(`dbt build${st.sel ? ` --select ${q(st.sel)}` : ''}${st.exc ? ` --exclude ${q(st.exc)}` : ''}`, e.currentTarget);
};
$('#png').onclick = () => {
  const a = document.createElement('a');
  a.href = st.mode === 'columns' ? cols.png() : cy.png({ full: true, scale: 2, bg: '#0b0e14', maxWidth: 12000, maxHeight: 12000 });
  a.download = `dag-${(st.p.split('/').pop())}${st.sel ? '-' + st.sel.replace(/[^\w.-]+/g, '_') : ''}.png`;
  a.click();
};

$('#find').addEventListener('input', () => {
  const q = $('#find').value.trim().toLowerCase();
  cy.nodes().removeClass('found');
  if (!q) return;
  const f = cy.nodes().filter(n => n.data('label').toLowerCase().includes(q)).addClass('found');
  if (f.length === 1) cy.animate({ center: { eles: f }, zoom: Math.max(cy.zoom(), 1), duration: 200 });
  else if (f.length) cy.animate({ fit: { eles: f, padding: 120 }, duration: 200 });
});
$('#find').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const f = cy.nodes('.found'); if (f.nonempty()) openPanel(f[0].id()); }
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#find').focus(); $('#find').select(); return; }
  if (e.target.matches('input, select, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#sel').focus(); $('#sel').select(); }
  else if (e.key === 'Escape') closePanel();
  else if (e.key === 'f') fit();
  else if ({ g: 'graph', u: 'usage', c: 'columns' }[e.key]) setMode({ g: 'graph', u: 'usage', c: 'columns' }[e.key]);
});

window.addEventListener('focus', () => loadProjects().catch(() => {}));

window.jordag = { cy, st, render, cols };  // console access for poking around
const startMode = readUrl();
loadProjects().then(() => { if (startMode !== 'graph') setMode(startMode, false); writeUrl(false); poll(); }).catch(() => showStatus(null));
