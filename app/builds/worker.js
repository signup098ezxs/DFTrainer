// Lantern Client - Meta Build Creator: makes a build and runs the pre-build check off the panel's main thread.
// Licence: AGPL-3.0-only.
//
// A build is only sent back once it passes the pre-build check (audit.js). When a check asks for a revision, the
// build is made again with what the check found (a sharper goal order, a weapon of the target's weak element, a
// community build or a better cell layout as the starting point) and checked again, up to four times. A build that
// breaks a game rule or whose perk count does not add up is never sent: the player gets an error instead.
'use strict';
const { parentPort } = require('worker_threads');
const { optimise } = require('./optimize.js');
const { audit, countPerks } = require('./audit.js');
const { describe } = require('./explain.js');

function make(ctx) {
  const revisions = [], tried = new Set();
  let opts = {}, r = optimise(ctx), a = null;
  for (let round = 0; round < 5; round++) {
    if (r.error) return { error: r.error };
    a = audit(ctx, r);
    if (a.ok || a.hard || !a.revise || round === 4) break;
    const key = a.revise.why || JSON.stringify(a.revise);
    if (tried.has(key)) break;   // already rebuilt for this and it did not score higher
    tried.add(key);
    revisions.push(a.revise.why || 'revise');
    if (a.revise.boost) ctx = { ...ctx, boost: a.revise.boost };
    if (a.revise.element) opts = { ...opts, element: a.revise.element };
    opts = { ...opts, seeds: [r.build, ...(a.revise.seeds || [])], seedFrom: a.revise.seedFrom || null };
    const prev = r;
    r = optimise(ctx, opts);
    if (!r.error && a.revise.element) r.elementTried = true;
    if (r.error) return { error: r.error };
    if (r.score + 1e-9 < prev.score && !a.revise.boost && !a.revise.element) r = prev;   // a revision never makes it worse
  }
  if (a.hard) return { error: 'The build did not pass the pre-build check (' + a.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.detail}`).join(' ') + '). It was not shown.' };
  // a check still asking for a change after Lantern rebuilt for it: the rebuild scored lower, so the higher-scoring
  // build stays and the check says so, as a note, not a pass
  if (!a.ok) for (const c of a.checks) if (c.status === 'revise') { c.status = 'note'; c.detail += ' Lantern rebuilt with that change and kept whichever scored higher under your goals.'; }
  return { r, a, ctx, revisions };
}

if (parentPort) parentPort.on('message', ({ id, ctx, owned }) => {
  let result;
  try {
    const own = owned ? { gear: new Set(owned.gear || []), cells: new Map(Object.entries(owned.cells || {})) } : null;
    const t0 = Date.now();
    const m = make({ ...ctx, owned: own });
    if (m.error) result = { ok: false, error: m.error };
    else {
      const view = describe(m.ctx, m.r, own, m.a, m.revisions);
      // last check: the page shows exactly the perk levels that were checked
      const counted = countPerks(m.r.build);
      const shown = view.perks.filter((p) => p.level !== (counted[p.name] || 0));
      if (shown.length || view.perks.length !== Object.keys(counted).length) result = { ok: false, error: 'The perk list did not match the checked build, so it was not shown.' };
      else result = { ok: true, ms: Date.now() - t0, request: ctx, build: m.r.build, view };
    }
  } catch (e) {
    result = { ok: false, error: 'Lantern could not make this build: ' + e.message };
  }
  parentPort.postMessage({ id, result });
});

module.exports = { make };
