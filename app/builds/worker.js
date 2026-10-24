// Lantern Client - Meta Build Creator: runs the search off the panel's main thread. Licence: AGPL-3.0-only.
'use strict';
const { parentPort } = require('worker_threads');
const { optimise } = require('./optimize.js');
const { describe } = require('./explain.js');

parentPort.on('message', ({ id, ctx, owned }) => {
  let result;
  try {
    const own = owned ? { gear: new Set(owned.gear || []), cells: new Map(Object.entries(owned.cells || {})) } : null;
    const c = { ...ctx, owned: own };
    const t0 = Date.now();
    const r = optimise(c);
    if (r.error) result = { ok: false, error: r.error };
    else result = { ok: true, ms: Date.now() - t0, request: ctx, build: r.build, view: describe(c, r, own) };
  } catch (e) {
    result = { ok: false, error: 'Lantern could not make this build: ' + e.message };
  }
  parentPort.postMessage({ id, result });
});
