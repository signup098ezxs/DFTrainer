// Lantern Client - the Host Mode relay fix. Licence: AGPL-3.0-only.
//
// TEMPORARY, until Dauntless Forever fixes it (addison2k/DauntlessForever#12). In Host Mode DF's backend
// (backend\recorder-1147.js, GET /candidate/status) gives every game the relay's address for the city and hunt servers,
// the host's own game too, so the host's game goes out to the relay and back to the same PC (~110 ms instead of ~10).
// The fix: only joiners (guestRequest: 127.0.0.2 through DF's gateway, or a LAN address) get the relay's address.
//
// DF's launcher puts its original file back when it checks its files ("package checked ... WRONG"), usually when it
// starts. server.js then applies the fix again (hostFixSync). It only ever replaces this one exact line of DF's code:
// if DF changes that code (a fix of its own, or anything else), Lantern leaves the file alone and says so.
// To turn it off: "hostFix": false in trainer-settings.json. To retire it once DF has fixed the issue: delete this file
// and its few lines in server.js (search "hostFix").
'use strict';
const MARK = 'DF-HOSTLOCAL';
const OLD = "if (srv) out.serverInfo = { buildId: cd.buildId, gameSessionId: cd.gameSessionId, host: (PUBLIC_HOST && (!srv.host || srv.host === '127.0.0.1')) ? PUBLIC_HOST : (srv.host || '127.0.0.1'), port: srv.port + (PUBLIC_HOST ? PUBLIC_PORT_OFFSET : 0) };";
const NEW = "// DF-HOSTLOCAL (Lantern Client, until addison2k/DauntlessForever#12 is fixed): the host's own game (127.0.0.1) plays on this PC, not out to the relay and back\n" +
  "    const viaPublic = PUBLIC_HOST && guestRequest(c.req);\n" +
  "    if (srv) out.serverInfo = { buildId: cd.buildId, gameSessionId: cd.gameSessionId, host: (viaPublic && (!srv.host || srv.host === '127.0.0.1')) ? PUBLIC_HOST : (srv.host || '127.0.0.1'), port: srv.port + (viaPublic ? PUBLIC_PORT_OFFSET : 0) };";
const CODE = NEW.slice(NEW.indexOf('\n') + 1);   // the two code lines; the comment above them may differ (the 9 Nov hand patch)
const count = (s, part) => s.split(part).length - 1;

// 'patched'  the fix is in, exactly once, and DF's line is gone
// 'original' DF's own file with the line to fix exactly once: safe to patch
// 'changed'  anything else (DF changed this code, or someone else edited it): never touched
function status(text) {
  const s = String(text);
  if (count(s, CODE) === 1 && count(s, OLD) === 0 && count(s, MARK) === 1 && /\nfunction guestRequest\(req\)/.test(s)) return 'patched';
  if (count(s, OLD) === 1 && count(s, MARK) === 0) return 'original';
  return 'changed';
}
function patch(text) {
  if (status(text) !== 'original') throw new Error('not the file this fix is for');
  return String(text).replace(OLD, () => NEW);
}
module.exports = { status, patch, MARK };
