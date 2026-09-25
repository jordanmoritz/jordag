// Prod usage from Snowflake ACCESS_HISTORY (/api/usage): per-node summaries + verdicts, the Usage table, the panel section.
// Rows from the server are [key, q7, q30, q90, lastISO]; key is ROLE:USER for reads/writes, else a Metabase dashboard/card id.
// Consumers are the configured consumer roles (or, unconfigured, every role that isn't pipeline or team); people who use a
// team role are team whatever role they queried with; roles that write objects (dbt, loaders) are pipeline; the rest "other".

const COL = { 7: 1, 30: 2, 90: 3 };
const BUILDABLE = new Set(['model', 'seed', 'snapshot']);
// in order of how much attention they need (also the default sort)
export const VERDICTS = {
  unused: ['unused', 'no readers and nothing downstream: a cleanup candidate'],
  dormant: ['no activity', 'not read or rebuilt in prod in 90 days'],
  team: ['team only', 'no consumer reads; only the team poking around'],
  pipeline: ['pipeline', 'no consumer or team reads, but it feeds downstream models (only dbt reads it, if anything)'],
  active: ['active', 'read by consumer roles in this window'],
  new: ['not in prod', 'new on this branch'],
};

export function summarize(u, g, id, win = 30) {
  const n = g.byId.get(id), rows = u.nodes[id] || {}, i = COL[win];
  const consumer = new Set(u.consumer_roles), pipe = new Set(u.pipeline_roles), people = new Set(u.team_users);
  const anyConsumer = !consumer.size;  // no consumer roles configured: every non-pipeline, non-team role counts
  const s = { prod: u.prod[id] || null, consumers: [], team: [], other: [], pipeline: 0, reads: 0, lastRead: 0, lastBuilt: 0 };
  const add = (list, who, c, t) => {
    const x = list.find(y => y[0] === who);
    if (x) { x[1] += c; x[2] = Math.max(x[2], t); } else list.push([who, c, t]);
  };
  for (const [key, ...q] of rows.read || []) {
    const c = q[i - 1], t = Date.parse(q[3]), j = key.indexOf(':'), role = key.slice(0, j), user = key.slice(j + 1);
    if (!c) continue;
    if (people.has(user)) { add(s.team, user, c, t); s.lastRead = Math.max(s.lastRead, t); }
    else if (pipe.has(role)) s.pipeline += c;
    else if (anyConsumer || consumer.has(role)) { add(s.consumers, role, c, t); s.reads += c; s.lastRead = Math.max(s.lastRead, t); }
    else add(s.other, `${user} as ${role}`, c, t);
  }
  for (const w of rows.write || []) s.lastBuilt = Math.max(s.lastBuilt, Date.parse(w[4]));
  const hits = k => (rows[k] || []).filter(r => r[i]).map(r => [r[0], r[i], Date.parse(r[4])]).sort((a, b) => b[1] - a[1]);
  s.dash = hits('dash');
  s.cards = hits('card');
  for (const l of [s.consumers, s.team, s.other]) l.sort((a, b) => b[1] - a[1]);
  const kids = g.children.get(id).map(k => g.byId.get(k));
  s.downstream = kids.filter(k => BUILDABLE.has(k.type)).length;
  s.exposures = kids.filter(k => k.type === 'exposure').length;
  s.verdict = !s.prod ? null
    : s.reads ? 'active'
    : s.team.length ? 'team'
    : !rows.read && !rows.write ? (n.state === 'new' ? 'new' : 'dormant')
    : s.downstream ? 'pipeline' : 'unused';
  return s;
}

const dash = n => n ? fmt(n) : '—';
export const fmt = n => n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
export const since = ms => {
  if (!ms) return '—';
  const s = (Date.now() - ms) / 1000;
  return s < 5400 ? `${Math.max(1, Math.round(s / 60))}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
export const verdictPill = v => v ? `<span class="verdict v-${v}" title="${VERDICTS[v][1]}">${VERDICTS[v][0]}</span>` : '';

// ------------------------------------------------------------ panel section

export function panelSection(u, g, id, win, esc) {
  if (!u) return '';
  if (u.unsupported) return `<details class="usage"><summary>Prod usage</summary><p class="note">${esc(u.unsupported)}</p></details>`;
  const head = `<summary>Prod usage<span>${win}d</span><span class="wins">${[7, 30, 90].map(w =>
    `<button data-win="${w}" class="${w === win ? 'on' : ''}">${w}d</button>`).join('')}</span></summary>`;
  if (!u.at) {
    return `<details open class="usage">${head}<p class="note">${u.error ? `Couldn't read usage: ${esc(u.error.split('\n').pop())}`
      : '<span class="spin-sm"></span>Reading ACCESS_HISTORY from Snowflake (~1 min, then cached for 12h)…'}</p></details>`;
  }
  const s = summarize(u, g, id, win);
  if (!s.prod) return '';
  const max = Math.max(1, ...[...s.consumers, ...s.team, ...s.other].map(c => c[1]));
  const legacy = new Set(u.legacy_roles);
  const bar = (who, n, last, cls = '') => `<div class="ubar ${cls}"><span>${esc(who)}</span><i style="width:${Math.max(2, 100 * n / max)}%"></i><b>${fmt(n)}</b><em>${since(last)}</em></div>`;
  const link = (kind, x) => {
    const exp = kind === 'dashboard' && u.dashboards[x[0]], known = exp && g.byId.get(exp);
    const href = u.metabase ? `${u.metabase}/${kind === 'dashboard' ? 'dashboard' : 'question'}/${x[0]}` : null;
    const title = u.names?.[kind === 'dashboard' ? 'dash' : 'card']?.[x[0]];
    const tag = known ? `<span class="note" title="declared as exposure ${esc(known.name)}">✓</span>`
      : kind === 'dashboard' ? '<span class="note undeclared" title="no exposure in this project points at this dashboard">undeclared</span>' : '';
    return `<li><a ${href ? `href="${esc(href)}" target="_blank" rel="noopener"` : ''} title="#${esc(x[0])}">${title ? esc(title) : `#${esc(x[0])}${known ? ` <span class="note">${esc(known.label || known.name)}</span>` : ''}`} ${tag}</a><b>${fmt(x[1])}</b><em>${since(x[2])}</em></li>`;
  };
  return `<details open class="usage">${head}
    <div class="usum">${verdictPill(s.verdict)} <b>${fmt(s.reads)}</b> consumer ${s.reads === 1 ? 'query' : 'queries'} · last read ${since(s.lastRead)}</div>
    ${s.consumers.map(c => bar(c[0] + (legacy.has(c[0]) ? ' (legacy)' : ''), c[1], c[2])).join('')}
    ${s.team.map(c => bar(c[0], c[1], c[2], 'teamrow')).join('')}
    ${s.other.map(c => bar(c[0], c[1], c[2], 'otherrow')).join('')}
    <div class="note umeta">${s.pipeline ? `read ${fmt(s.pipeline)}× by dbt builds · ` : ''}rebuilt ${since(s.lastBuilt)} · <code>${esc(s.prod)}</code></div>
    ${u.names && !u.names.enabled && (s.dash.length || s.cards.length) ? '<p class="note">set METABASE_API_KEY and run <code>jordag restart</code> to see dashboard and question names</p>' : ''}
    ${s.dash.length ? `<div class="ulist"><h4>Metabase dashboards <span>${s.dash.length}</span></h4><ul>${s.dash.slice(0, 12).map(x => link('dashboard', x)).join('')}</ul></div>` : ''}
    ${s.cards.length ? `<div class="ulist"><h4>Saved questions outside dashboards <span>${s.cards.length}</span></h4><ul>${s.cards.slice(0, 8).map(x => link('card', x)).join('')}</ul></div>` : ''}
  </details>`;
}

// ------------------------------------------------------------ Usage table view

const who = u => [
  `consumers = ${u.consumer_roles.length ? u.consumer_roles.filter(r => !u.legacy_roles.includes(r)).join(', ') + (u.legacy_roles.length ? ` + legacy ${u.legacy_roles.join(', ')}` : '') : 'every role that isn\'t pipeline or team (set consumer_roles in config)'}`,
  `team = ${u.team_roles.length ? `people using ${u.team_roles.join(', ')}` : 'none configured'}`,
  `pipeline = ${u.pipeline_roles.join(', ') || 'none detected'}`,
].join('\n');

const SORTS = {
  name: (a, b) => a.label.localeCompare(b.label),
  verdict: (a, b) => Object.keys(VERDICTS).indexOf(a.s.verdict) - Object.keys(VERDICTS).indexOf(b.s.verdict),
  reads: (a, b) => a.s.reads - b.s.reads,
  consumers: (a, b) => a.s.consumers.length - b.s.consumers.length,
  other: (a, b) => a.s.other.reduce((t, x) => t + x[1], 0) - b.s.other.reduce((t, x) => t + x[1], 0),
  dash: (a, b) => a.s.dash.length - b.s.dash.length,
  team: (a, b) => a.s.team.reduce((t, x) => t + x[1], 0) - b.s.team.reduce((t, x) => t + x[1], 0),
  downstream: (a, b) => a.s.downstream - b.s.downstream,
  lastRead: (a, b) => a.s.lastRead - b.s.lastRead,
  lastBuilt: (a, b) => a.s.lastBuilt - b.s.lastBuilt,
};

export function tableHtml(u, g, ids, opt, h) {
  const { esc, color, label } = h;
  if (u?.unsupported) return `<div class="uempty"><p>${esc(u.unsupported)}</p><p class="note">Graph and Columns work on any adapter.</p></div>`;
  if (!u || !u.at) {
    return `<div class="uempty">${u?.error ? `<p>Couldn't read usage from Snowflake:</p><pre>${esc(u.error)}</pre><button data-refresh>Retry</button>`
      : '<div class="spin"></div><p>Reading ACCESS_HISTORY from Snowflake…</p><p class="note">about a minute the first time, then cached for 12h</p>'}</div>`;
  }
  const rows = ids.map(id => ({ id, n: g.byId.get(id), label: label(g.byId.get(id)), s: summarize(u, g, id, opt.win) })).filter(r => r.s.prod);
  const counts = {};
  for (const r of rows) counts[r.s.verdict] = (counts[r.s.verdict] || 0) + 1;
  const shown = rows.filter(r => !opt.verdict || r.s.verdict === opt.verdict);
  const cmp = SORTS[opt.sort] || SORTS.verdict;
  shown.sort((a, b) => (opt.desc ? -1 : 1) * (cmp(a, b) || a.label.localeCompare(b.label)));
  const max = Math.max(1, ...shown.map(r => r.s.reads));
  const th = (k, t, title = '') => `<th data-sort="${k}" class="${opt.sort === k ? (opt.desc ? 'desc' : 'asc') : ''}" title="${title}">${t}</th>`;
  const LIMIT = 400;  // ponytail: plenty for a selection; narrow with --select for more
  return `${u.hint ? `<p class="uhint">${esc(u.hint)}</p>` : ''}
    <div class="utool">
      <span class="wins">${[7, 30, 90].map(w => `<button data-win="${w}" class="${w === opt.win ? 'on' : ''}">${w}d</button>`).join('')}</span>
      <button class="vchip ${!opt.verdict ? 'on' : ''}" data-verdict="">all <b>${rows.length}</b></button>
      ${Object.keys(VERDICTS).filter(v => counts[v]).map(v => `<button class="vchip v-${v} ${opt.verdict === v ? 'on' : ''}" data-verdict="${v}" title="${VERDICTS[v][1]}">${VERDICTS[v][0]} <b>${counts[v]}</b></button>`).join('')}
      <span class="note grow" title="${esc(who(u))}">${u.fetching ? '<span class="spin-sm"></span>refreshing… · ' : ''}ACCESS_HISTORY as of ${since(u.at * 1000)} (lags ~3h) · ${esc(who(u).replace(/\n/g, ' · '))}</span>
      <button data-refresh title="Re-read ACCESS_HISTORY now (~1 min)">↻ usage</button>
    </div>
    <table class="utable">
      <thead><tr>${th('name', 'node')}${th('verdict', 'verdict')}${th('reads', `queries · ${opt.win}d`, 'consumer queries, excluding pipeline and team')}${th('consumers', 'roles', 'consumer roles that read it')}${th('dash', 'dashboards', 'Metabase dashboards that queried it')}${th('team', 'team', 'queries by people who use a team role')}${th('other', 'other', 'reads by roles that are neither consumer, team, nor pipeline')}${th('downstream', 'downstream', 'dbt models built from it')}${th('lastRead', 'last read')}${th('lastBuilt', 'last built')}</tr></thead>
      <tbody>${shown.slice(0, LIMIT).map(({ id, n, label: l, s }) => `
        <tr data-id="${esc(id)}" class="${opt.focus === id ? 'sel' : ''}">
          <td class="nm"><i style="background:${color(n.type)}"></i>${esc(l)}${n.state ? ` <span class="badge ${n.state}">${n.state}</span>` : ''}</td>
          <td>${verdictPill(s.verdict)}</td>
          <td class="r"><span class="minibar"><i style="width:${100 * s.reads / max}%"></i></span>${fmt(s.reads)}</td>
          <td class="r" title="${esc(s.consumers.map(c => `${c[0]}: ${c[1]}`).join('\n'))}">${s.consumers.length ? `${s.consumers.length} <span class="note">${esc(s.consumers[0][0].toLowerCase())}${s.consumers.length > 1 ? ' +' + (s.consumers.length - 1) : ''}</span>` : '—'}</td>
          <td class="r" title="${esc(s.dash.map(x => u.names?.dash?.[x[0]] || '#' + x[0]).join('\n'))}">${s.dash.length || '—'}</td>
          <td class="r" title="${esc(s.team.map(c => `${c[0]}: ${c[1]}`).join('\n'))}">${dash(s.team.reduce((t, x) => t + x[1], 0))}</td>
          <td class="r" title="${esc(s.other.map(c => `${c[0]}: ${c[1]}`).join('\n'))}">${dash(s.other.reduce((t, x) => t + x[1], 0))}</td>
          <td class="r">${s.downstream || '—'}${s.exposures ? ` <span class="note" title="declared exposures">+${s.exposures} exp</span>` : ''}</td>
          <td class="r">${since(s.lastRead)}</td>
          <td class="r ${s.lastBuilt && Date.now() - s.lastBuilt > 3 * 864e5 ? 'warn' : ''}">${since(s.lastBuilt)}</td>
        </tr>`).join('')}</tbody>
    </table>
    ${shown.length > LIMIT ? `<p class="note">showing ${LIMIT} of ${shown.length}; narrow with --select</p>` : ''}
    ${!shown.length ? `<p class="note">nothing here${opt.verdict ? ' with that verdict' : ''}</p>` : ''}`;
}
