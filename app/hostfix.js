// Lantern Client - the Host Mode relay fix, RETIRED in 3.9.37. Licence: AGPL-3.0-only.
//
// 3.9.32-3.9.36 patched one line of DF's backend\recorder-1147.js (addison2k/DauntlessForever#12: in Host Mode the
// host's own game went out to the relay and back). DF is fixing it itself, so Lantern no longer patches anything.
// This file only lets server.js (hostFixUndo) recognise Lantern's old fix and DF's original, to put DF's original back
// on a PC that was patched. Delete it, and hostFixUndo in server.js, once everyone has updated past 3.9.37.
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
