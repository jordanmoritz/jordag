// Columns mode: lineage for one column at a time, drawn as model cards holding only the columns on its path.
// Its own cytoscape instance, created on first entry, so the main graph never pays for it.

const ROW = 24, HEAD = 30;
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const FONT = '-apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif';
const key = (id, col) => `${id}|${col}`;
const split = k => { const i = k.lastIndexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };

export function initColumns(h) {
  const { st, $, api, esc, enc, color, tint, label, hl } = h;
  const ctx = document.createElement('canvas').getContext('2d');
  const textW = (s, font) => { ctx.font = font; return ctx.measureText(s).width; };
  let cyc = null, last = null, timer = null;

  const name = id => st.g?.byId.get(id) ? label(st.g.byId.get(id)) : id;  // raw relations (not in the project) show as-is
  const typeColor = id => st.g?.byId.get(id) ? color(st.g.byId.get(id).type) : '#64748b';

  function ensureCy() {
    if (cyc) return cyc;
    cyc = cytoscape({
      container: $('#cyc'), wheelSensitivity: 0.3, minZoom: 0.05, maxZoom: 2.5, boxSelectionEnabled: false,
      style: [
        { selector: 'node.model', style: { shape: 'round-rectangle', 'background-color': 'data(bg)', 'border-color': 'data(color)', 'border-width': 1.5, padding: 8, label: '' } },
        { selector: 'node.hdr', style: { shape: 'rectangle', width: 'data(w)', height: 22, 'background-opacity': 0, 'border-width': 0, label: 'data(label)', color: 'data(color)',
          'font-size': 12, 'font-weight': 700, 'font-family': FONT, 'text-valign': 'center', 'text-halign': 'center' } },
        { selector: 'node.col', style: { shape: 'round-rectangle', width: 'data(w)', height: 20, 'background-color': '#0e131e', 'border-width': 1, 'border-color': '#2a3346',
          label: 'data(label)', color: '#dfe5f1', 'font-size': 11, 'font-family': MONO, 'text-valign': 'center', 'text-halign': 'center' } },
        { selector: 'node.col.t', style: { color: '#f5d48a' } },
        { selector: 'node.col.focus', style: { 'background-color': '#24366e', 'border-color': '#8aa8ff', 'border-width': 2, color: '#ffffff', 'font-weight': 700 } },
        { selector: 'node.col:selected', style: { 'border-color': '#ffffff', 'border-width': 2 } },
        { selector: 'edge', style: { width: 1.3, 'line-color': '#3a4861', 'target-arrow-color': '#3a4861', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier' } },
        { selector: 'edge.hl', style: { 'line-color': '#8aa8ff', 'target-arrow-color': '#8aa8ff', width: 2, 'z-index': 10 } },
        { selector: '.faded', style: { opacity: 0.15 } },
      ],
    });
    cyc.on('mouseover', 'node.col', e => highlight(e.target));
    cyc.on('mouseout', 'node.col', () => highlight(st.colSel && cyc.getElementById(st.colSel)));
    cyc.on('tap', 'node.col', e => showColumn(e.target.id()));
    cyc.on('dbltap', 'node.col', e => focus(...split(e.target.id())));
    cyc.on('tap', 'node.hdr', e => pickModel(e.target.data('model')));
    cyc.on('tap', e => { if (e.target === cyc) { st.colSel = null; h.closePanel(); highlight(null); } });
    return cyc;
  }

  function highlight(n) {
    cyc.batch(() => {
      cyc.elements().removeClass('faded hl');
      if (!n || n.empty()) return;
      const lin = n.predecessors().union(n.successors()).union(n);
      cyc.elements('node.col, edge').difference(lin).addClass('faded');
      lin.edges().addClass('hl');
    });
  }

  function draw(t) {
    const c = ensureCy(), focusKey = key(...t.focus);
    const groups = new Map();
    for (const n of t.nodes) (groups.get(n.id) || groups.set(n.id, []).get(n.id)).push(n);
    const width = new Map([...groups].map(([id, cols]) => [id, Math.max(150, textW(name(id), `700 12px ${FONT}`) + 24,
      ...cols.map(x => textW((x.t ? 'ƒ ' : '') + x.col.toLowerCase(), `11px ${MONO}`) + 28))]));
    const D = new dagre.graphlib.Graph();
    D.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 120, marginx: 30, marginy: 30 });
    D.setDefaultEdgeLabel(() => ({}));
    for (const [id, cols] of groups) D.setNode(id, { width: width.get(id) + 16, height: HEAD + cols.length * ROW + 16 });
    const ups = new Map();
    for (const [a, b] of t.edges) {
      const [ma] = split(a), [mb] = split(b);
      if (ma !== mb) D.setEdge(ma, mb);
      (ups.get(b) || ups.set(b, []).get(b)).push(a);
    }
    dagre.layout(D);
    // left to right, order each card's columns by where their inputs sit, to keep edges from crossing
    const y = new Map();
    for (const id of [...groups.keys()].sort((a, b) => D.node(a).x - D.node(b).x)) {
      const box = D.node(id), top = box.y - box.height / 2 + 8;
      const score = n => { const ys = (ups.get(key(n.id, n.col)) || []).map(k => y.get(k)).filter(v => v != null); return ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : 1e9; };
      groups.get(id).sort((a, b) => score(a) - score(b) || a.col.localeCompare(b.col))
        .forEach((n, i) => y.set(key(n.id, n.col), top + HEAD + i * ROW + ROW / 2));
    }
    const els = [];
    for (const [id, cols] of groups) {
      const col = typeColor(id), box = D.node(id), w = width.get(id);
      els.push({ group: 'nodes', data: { id: 'm:' + id, bg: tint(col, 0.12), color: col }, classes: 'model' });
      els.push({ group: 'nodes', data: { id: 'h:' + id, parent: 'm:' + id, label: name(id), w, color: col, model: id },
        position: { x: box.x, y: box.y - box.height / 2 + 19 }, classes: 'hdr' });
      for (const n of cols) {
        const k = key(n.id, n.col);
        els.push({ group: 'nodes', data: { id: k, parent: 'm:' + id, label: (n.t ? 'ƒ ' : '') + n.col.toLowerCase(), w },
          position: { x: box.x, y: y.get(k) }, classes: ['col', n.t && 't', k === focusKey && 'focus'].filter(Boolean).join(' ') });
      }
    }
    for (const [a, b] of t.edges) if (a !== b) els.push({ group: 'edges', data: { id: `${a}>${b}`, source: a, target: b } });
    c.batch(() => { c.elements().remove(); c.add(els); });
    c.resize();
    c.fit(undefined, 40);
    if (c.zoom() > 1.2) { c.zoom(1.2); c.center(c.getElementById(focusKey)); }
    if (st.colSel && c.getElementById(st.colSel).nonempty()) c.getElementById(st.colSel).select();
  }

  // ------------------------------------------------------------ side panel for a column

  function showColumn(k) {
    const t = last;
    if (!t) return;
    st.colSel = k;
    const [id, col] = split(k);
    const n = t.nodes.find(x => x.id === id && x.col === col) || { id, col };
    const ups = t.edges.filter(e => e[1] === k).map(e => e[0]), downs = t.edges.filter(e => e[0] === k).map(e => e[1]);
    const li = x => { const [i, c] = split(x); return `<li><a data-col="${esc(x)}"><i style="background:${typeColor(i)}"></i><span>${esc(name(i))}.<b>${esc(c.toLowerCase())}</b></span></a></li>`; };
    const node = st.g?.byId.get(id);
    h.showPanel(`
      <div class="ph"><span class="badge" style="--c:${typeColor(id)}">column</span>
        <span class="badge">${n.t ? 'computed' : n.nup ? 'passed through' : node?.type === 'source' ? 'source column' : node?.type === 'seed' ? 'seed column' : 'no inputs'}</span>
        <button class="x" data-act="close" title="close (esc)">✕</button></div>
      <h2>${esc(col.toLowerCase())}</h2>
      <div class="kv"><span>in</span><code>${esc(name(id))}</code>${node ? `<button data-model="${esc(id)}" title="open this model in the graph">graph ↗</button>` : '<i></i>'}</div>
      ${n.type ? `<div class="kv"><span>type</span><code>${esc(n.type)}</code><i></i></div>` : ''}
      <div class="actions">
        ${k !== key(...t.focus) ? `<button class="primary" data-trace="${esc(k)}">Trace from here</button>` : ''}
        <button data-pick="${esc(id)}">All columns of ${esc(name(id))}</button>
      </div>
      ${n.desc ? `<p class="desc">${esc(n.desc)}</p>` : ''}
      ${n.expr && n.t ? `<details open><summary>Computed as</summary><pre class="code">${hl(n.expr)}</pre></details>` : ''}
      ${ups.length ? `<details open><summary>Comes from<span>${ups.length}</span></summary><ul>${ups.map(li).join('')}</ul></details>` : ''}
      ${downs.length ? `<details open><summary>Feeds<span>${downs.length}</span></summary><ul>${downs.map(li).join('')}</ul></details>` : ''}`);
    cyc.resize();
    cyc.$(':selected').unselect();
    const el = cyc.getElementById(k);
    el.select();
    highlight(el);
  }

  $('#panel').addEventListener('click', e => {
    const b = e.target.closest('[data-col],[data-trace],[data-pick],[data-model]');
    if (!b || st.mode !== 'columns') return;
    if (b.dataset.col) { const el = cyc.getElementById(b.dataset.col); cyc.animate({ center: { eles: el }, duration: 200 }); showColumn(b.dataset.col); }
    else if (b.dataset.trace) focus(...split(b.dataset.trace));
    else if (b.dataset.pick) pickModel(b.dataset.pick);
    else if (b.dataset.model) h.openModel(b.dataset.model);
  });

  // ------------------------------------------------------------ picker: model -> its columns

  function suggestModels() {
    const g = st.g;
    if (!g) return;
    const q = $('#colpick').value.toLowerCase();
    $('#colpick-list').innerHTML = g.nodes.filter(n => ['model', 'source', 'seed', 'snapshot'].includes(n.type) && label(n).toLowerCase().includes(q))
      .slice(0, 60).map(n => `<option value="${esc(label(n))}">`).join('');
  }
  $('#colpick').addEventListener('input', () => {
    suggestModels();
    const hit = st.g?.nodes.find(n => label(n) === $('#colpick').value);
    if (hit) pickModel(hit.id);
  });
  $('#colpick').addEventListener('focus', suggestModels);

  let pickedBlind = false;  // picked before the project graph loaded: names need a redraw
  async function pickModel(id) {
    st.colModel = id;
    pickedBlind = !st.g;
    $('#colpick').value = name(id);
    const d = await api(`/api/columns?p=${enc(st.p)}&id=${enc(id)}`);
    if (st.colModel !== id) return;
    const cols = d.columns || [];
    $('#colcols').hidden = false;
    $('#colcols').innerHTML = d.status !== 'ready' ? '' : !cols.length ? `<p class="note">No columns known for ${esc(name(id))}.</p>`
      : `<h4>${esc(name(id))} <span>${cols.length} columns</span></h4><div>${cols.map(c =>
        `<button data-c="${esc(c.col)}" class="${st.col && st.col.id === id && st.col.col === c.col ? 'on' : ''}" title="${c.up} inputs · feeds ${c.down}">${esc(c.col.toLowerCase())}<small>${c.up ? '↑' + c.up : ''}${c.down ? ' ↓' + c.down : ''}</small></button>`).join('')}</div>`;
  }
  $('#colcols').addEventListener('click', e => {
    const b = e.target.closest('[data-c]');
    if (b) focus(st.colModel, b.dataset.c);
  });

  for (const b of document.querySelectorAll('#coldir button')) {
    b.onclick = () => { st.colDir = b.dataset.dir; h.writeUrl(true); load(); };
  }

  // ------------------------------------------------------------ loading

  function focus(id, col) {
    st.col = { id, col };
    st.colSel = null;
    h.closePanel();
    h.writeUrl(true);
    load();
    if (st.colModel !== id) pickModel(id);
    else for (const b of document.querySelectorAll('#colcols [data-c]')) b.classList.toggle('on', b.dataset.c === col);
  }

  function status(html) {
    $('#colstatus').hidden = !html;
    $('#colstatus').innerHTML = html;
  }

  async function load() {
    clearTimeout(timer);
    for (const b of document.querySelectorAll('#coldir button')) b.classList.toggle('on', b.dataset.dir === st.colDir);
    if (st.mode !== 'columns' || !st.p) return;
    const want = st.col;
    const d = await api(`/api/columns?p=${enc(st.p)}${want ? `&id=${enc(want.id)}&col=${enc(want.col)}&dir=${st.colDir}` : ''}`);
    if (st.mode !== 'columns' || want !== st.col) return;
    if (st.colModel && st.g && pickedBlind) pickModel(st.colModel);
    const busy = d.step ? `${d.step === 'tracing columns' ? `tracing columns ${esc(d.progress)}` : esc(d.step)}…` : '';
    $('#colinfo').innerHTML = d.status === 'ready' && d.nodes
      ? d.missing ? `<b class="warn">${esc(name(want.id))} has no column ${esc(want.col.toLowerCase())}</b>: pick one below`
      : `${d.nodes.length} columns · ${new Set(d.nodes.map(n => n.id)).size} nodes${d.truncated ? ' · <b class="warn">truncated: pick ↑ or ↓</b>' : ''}${busy ? ` · <span class="spin-sm"></span>updating: ${busy}` : ''}${d.warning ? ` · <span class="warn" title="${esc(d.warning)}">source columns from yml only</span>` : ''}`
      : busy ? `<span class="spin-sm"></span>${busy}` : '';
    if (d.status === 'error' && !d.nodes) {
      status(`<p>Column lineage failed to build.</p><pre>${esc(d.error)}</pre>`);
    } else if (d.status === 'building') {
      status(`<div class="spin"></div><p>Preparing column lineage for this worktree: ${busy}</p>
        <p class="note">compiles the project into jordag's cache, then traces every column with sqlglot.<br>about a minute the first time; after that only changed models are re-traced.</p>`);
    } else if (!want) {
      status(st.colModel ? `<p>Pick one of ${esc(name(st.colModel))}'s columns on the left to trace it.</p>`
        : `<p>Pick a column to trace.</p><p class="note">Type a model above and choose one of its columns,<br>or click a column in any model's details panel.</p>`);
      cyc?.elements().remove();
    } else {
      status('');
      const sig = JSON.stringify([d.focus, d.nodes.length, d.edges.length, st.colDir, !!st.g]);
      if (!last || sig !== last.sig || !cyc || cyc.elements().empty()) draw(d);
      last = Object.assign(d, { sig });
      if (st.colSel) showColumn(st.colSel);
    }
    if (d.status === 'building' || d.stale || d.step) timer = setTimeout(load, 1500);
  }

  return {
    enter(model) {
      ensureCy().resize();
      if (st.col) pickModel(st.col.id);
      else if (model) pickModel(model);
      load();
    },
    resize: () => cyc?.resize(),
    cy: () => cyc,
    leave() { clearTimeout(timer); },
    focus,
    refresh: load,
    fit: () => cyc?.animate({ fit: { eles: cyc.elements(), padding: 40 }, duration: 200 }),
    png: () => cyc?.png({ full: true, scale: 2, bg: '#0b0e14' }),
  };
}
