// node test.mjs
import assert from 'node:assert/strict';
import { index, select } from './web/selector.js';
import { summarize } from './web/usage.js';

const n = (id, type, extra = {}) => ({
  id, type, name: id.split('.').pop(), pkg: 'proj', path: '', fqn: ['proj', id.split('.').pop()],
  tags: [], config: {}, parents: [], ...extra,
});
const g = index([
  n('source.proj.raw.orders', 'source', { source_name: 'raw', path: 'models/staging/src.yml' }),
  n('model.proj.stg_orders', 'model', { parents: ['source.proj.raw.orders'], path: 'models/staging/stg_orders.sql',
    fqn: ['proj', 'staging', 'stg_orders'], config: { materialized: 'view' } }),
  n('model.proj.stg_users', 'model', { path: 'models/staging/stg_users.sql', fqn: ['proj', 'staging', 'stg_users'],
    config: { materialized: 'view' }, state: 'new' }),
  n('model.proj.fct_orders', 'model', { parents: ['model.proj.stg_orders', 'model.proj.stg_users'], tags: ['finance'],
    path: 'models/marts/fct_orders.sql', fqn: ['proj', 'marts', 'fct_orders'], config: { materialized: 'table' }, state: 'modified' }),
  n('exposure.proj.dash', 'exposure', { parents: ['model.proj.fct_orders'] }),
  n('test.proj.not_null_fct_orders_id', 'test', { parents: ['model.proj.fct_orders'], path: 'models/marts/schema.yml', test_name: 'not_null' }),
]);
const q = (s, x) => [...select(g, s, x, { root: 'proj' }).ids].map(id => id.split('.').pop()).sort().join(' ');

assert.equal(q('fct_orders'), 'fct_orders');
assert.equal(q('+fct_orders'), 'fct_orders orders stg_orders stg_users');
assert.equal(q('1+fct_orders'), 'fct_orders stg_orders stg_users');
assert.equal(q('fct_orders+'), 'dash fct_orders not_null_fct_orders_id');
assert.equal(q('stg_orders+1'), 'fct_orders stg_orders');
assert.equal(q('@stg_users'), 'dash fct_orders not_null_fct_orders_id orders stg_orders stg_users');
assert.equal(q('stg_*'), 'stg_orders stg_users');
assert.equal(q('proj.staging'), 'stg_orders stg_users');
assert.equal(q('staging'), 'stg_orders stg_users');
assert.equal(q('marts.fct_*'), 'fct_orders');
assert.equal(q('proj.*.stg_u*'), 'stg_users');
assert.equal(q('tag:finance'), 'fct_orders');
assert.equal(q('source:raw+1'), 'orders stg_orders');
assert.equal(q('source:raw.orders'), 'orders');
assert.equal(q('path:models/staging'), 'orders stg_orders stg_users');
assert.equal(q('models/staging'), 'orders stg_orders stg_users');
assert.equal(q('stg_orders.sql'), 'stg_orders');
assert.equal(q('config.materialized:view'), 'stg_orders stg_users');
assert.equal(q('config.materialized:view,stg_o*'), 'stg_orders');
assert.equal(q('stg_orders stg_users'), 'stg_orders stg_users');
assert.equal(q('+fct_orders', 'source:*'), 'fct_orders stg_orders stg_users');
assert.equal(q('state:modified'), 'fct_orders stg_users');
assert.equal(q('state:new'), 'stg_users');
assert.equal(q('resource_type:exposure'), 'dash');
assert.equal(q('exposure:dash'), 'dash');
assert.equal(q('test_type:generic'), 'not_null_fct_orders_id');
assert.equal(q('test_name:not_null'), 'not_null_fct_orders_id');
assert.equal(q('package:this,resource_type:source'), 'orders');
assert.equal(q(''), 'dash fct_orders not_null_fct_orders_id orders stg_orders stg_users');
assert.throws(() => q('bogus:x'), /unknown method/);
assert.deepEqual([...select(g, '+fct_orders').matched], ['model.proj.fct_orders']);
console.log('selector ok');

// usage verdicts: builders/loaders are pipeline, team reads don't make a node "active", leaves with no readers are "unused"
const T = '2026-01-01T12:00:00.000Z';
const ug = index([
  n('source.proj.raw.orders', 'source', { source_name: 'raw' }),
  n('model.proj.stg', 'model', { parents: ['source.proj.raw.orders'] }),
  n('model.proj.fct', 'model', { parents: ['model.proj.stg'] }),
  n('model.proj.team_toy', 'model', { parents: ['model.proj.stg'] }),
  n('model.proj.orphan', 'model', { parents: ['model.proj.stg'] }),
  n('model.proj.gone', 'model'),
  n('model.proj.fresh', 'model', { state: 'new' }),
]);
const u = {
  team_roles: ['ANALYST'], consumer_roles: ['BI_READER'], pipeline_roles: ['TRANSFORMER', 'LOADER'], team_users: ['PERSON_1'], legacy_roles: [],
  prod: Object.fromEntries(ug.nodes.map(x => [x.id, x.id.toUpperCase()])),
  nodes: {
    'source.proj.raw.orders': { read: [['LOADER:LOADER_USER', 1, 1, 1, T]], write: [['LOADER:LOADER_USER', 1, 1, 1, T]] },
    'model.proj.stg': { read: [['TRANSFORMER:DBT_USER', 3, 9, 20, T]], write: [['TRANSFORMER:DBT_USER', 1, 5, 9, T]] },
    'model.proj.fct': { read: [['BI_READER:BI_TOOL', 5, 20, 90, T], ['BI_READER:PERSON_1', 1, 2, 3, T], ['TRANSFORMER:DBT_USER', 9, 9, 9, T], ['SANDBOX:BOT', 1, 1, 1, T]], dash: [['7', 1, 4, 4, T]] },
    'model.proj.team_toy': { read: [['ANALYST:PERSON_1', 0, 2, 2, T]] },
    'model.proj.orphan': { write: [['TRANSFORMER:DBT_USER', 1, 1, 1, T]] },
  },
};
const v = (id, w = 30) => summarize(u, ug, id, w).verdict;
assert.equal(v('model.proj.fct'), 'active');
assert.equal(summarize(u, ug, 'model.proj.fct').reads, 20);
assert.equal(summarize(u, ug, 'model.proj.fct').pipeline, 9);
assert.deepEqual(summarize(u, ug, 'model.proj.fct').team.map(t => t.slice(0, 2)), [['PERSON_1', 2]]);  // a person under a consumer role is still team
assert.deepEqual(summarize(u, ug, 'model.proj.fct').other.map(t => t.slice(0, 2)), [['BOT as SANDBOX', 1]]);
assert.deepEqual(summarize(u, ug, 'model.proj.fct').dash.map(d => d.slice(0, 2)), [['7', 4]]);
assert.equal(v('model.proj.stg'), 'pipeline');
assert.equal(v('source.proj.raw.orders'), 'pipeline');
assert.equal(v('model.proj.team_toy'), 'team');
assert.equal(v('model.proj.team_toy', 7), 'unused');
assert.equal(v('model.proj.orphan'), 'unused');
assert.equal(v('model.proj.gone'), 'dormant');
assert.equal(v('model.proj.fresh'), 'new');
const open = { ...u, consumer_roles: [] };
assert.equal(summarize(open, ug, 'model.proj.fct').reads, 21);  // BI_TOOL 20 + BOT 1; team and pipeline still excluded
console.log('usage ok');
