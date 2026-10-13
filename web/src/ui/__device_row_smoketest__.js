// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/ui/__device_row_smoketest__.js
//
// Covers ui/device-row-logic.js: which device buttons the live chart's device row shows. Pure, so it
// is checked against hand-built states; the DOM class (ui/device-row.js) and its wiring into app.js
// are checked in the running app (scripts/browser-checks/device-row.py).

import {
  DEVICE_ROW_KINDS, offeredKinds, rowButtons, dismissShowing, normalizeStatus, buttonLabel, isRowKind,
} from './device-row-logic.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}
const kinds = (state) => rowButtons(state).map(b => b.kind).join(',');

console.log('what is offered');
check('the four kinds are controller, hrm, smo2 and coreTemp, in that order', DEVICE_ROW_KINDS.map(k => k.kind).join() === 'controller,hrm,smo2,coreTemp');
check('only devices connected at session start are offered', offeredKinds({ controller: 'connected', hrm: 'disconnected', smo2: 'connecting', coreTemp: 'reconnecting' }).join() === 'controller');
check('several connected devices are all offered, in display order', offeredKinds({ coreTemp: 'connected', hrm: 'connected', controller: 'connected' }).join() === 'controller,hrm,coreTemp');
check('nothing connected offers nothing', offeredKinds({}).length === 0 && offeredKinds().length === 0);
check('an unknown kind is never offered', !offeredKinds({ powerMeter: 'connected' }).length);

console.log('\nwhen a button shows');
const all = ['controller', 'hrm', 'smo2', 'coreTemp'];
check('connected: no button', kinds({ offered: all, statuses: { controller: 'connected', hrm: 'connected', smo2: 'connected', coreTemp: 'connected' } }) === '');
check('a dropped device gets a button', kinds({ offered: all, statuses: { controller: 'connected', hrm: 'disconnected', smo2: 'connected', coreTemp: 'connected' } }) === 'hrm');
check('it goes again when the device comes back', kinds({ offered: all, statuses: { hrm: 'connected', controller: 'connected', smo2: 'connected', coreTemp: 'connected' } }) === '');
check('several dropped devices keep display order', kinds({ offered: all, statuses: { coreTemp: 'disconnected', hrm: 'reconnecting', controller: 'disconnected', smo2: 'connected' } }) === 'controller,hrm,coreTemp');
check('a device that was NOT connected at start never shows, however it is doing now', kinds({ offered: ['controller'], statuses: { controller: 'connected', hrm: 'disconnected', smo2: 'reconnecting', coreTemp: 'connecting' } }) === '');
check('...not even after it connects and drops during the session (offered is fixed at start)', kinds({ offered: ['controller'], statuses: { controller: 'connected', hrm: 'disconnected' } }) === '');
check('no status yet reads as disconnected (the safe face)', kinds({ offered: ['hrm'], statuses: {} }) === 'hrm');
check('a garbled status reads as disconnected', normalizeStatus('???') === 'disconnected' && normalizeStatus(undefined) === 'disconnected');

console.log('\nbutton state');
const one = (status) => rowButtons({ offered: ['hrm'], statuses: { hrm: status } })[0];
check('disconnected: still, tappable', one('disconnected').tappable && !one('disconnected').animating);
check('connecting: pulsing, not tappable', !one('connecting').tappable && one('connecting').animating);
check('reconnecting: pulsing and STILL tappable (a tap ends the wait)', one('reconnecting').tappable && one('reconnecting').animating);
check('each button carries its icon and colour', one('disconnected').icon === 'icon-heart' && /color-hr/.test(one('disconnected').color));
check('labels say what a tap does', buttonLabel(one('disconnected')) === 'Connect heart rate monitor' && /^Connecting /.test(buttonLabel(one('connecting'))) && /pick a device/.test(buttonLabel(one('reconnecting'))));

console.log('\nthe X');
const state = { offered: all, dismissed: [], statuses: { controller: 'connected', hrm: 'disconnected', smo2: 'disconnected', coreTemp: 'connected' } };
const afterX = dismissShowing(state);
check('dismisses the buttons showing right now', afterX.join() === 'hrm,smo2', afterX.join());
check('and with that dismissal nothing shows', kinds({ ...state, dismissed: afterX }) === '');
check('a device that was connected when X was pressed is NOT dismissed: if it drops, it still shows',
  kinds({ ...state, dismissed: afterX, statuses: { ...state.statuses, controller: 'disconnected' } }) === 'controller');
check('a dismissed device stays dismissed when it flaps', kinds({ ...state, dismissed: afterX, statuses: { ...state.statuses, hrm: 'reconnecting' } }) === '');
check('pressing X twice does not lose earlier dismissals', dismissShowing({ ...state, dismissed: afterX, statuses: { ...state.statuses, controller: 'disconnected' } }).join() === 'hrm,smo2,controller');
check('X with nothing showing dismisses nothing', dismissShowing({ offered: all, dismissed: [], statuses: { controller: 'connected', hrm: 'connected', smo2: 'connected', coreTemp: 'connected' } }).length === 0);

console.log('\nkinds');
check('the row knows its four kinds and ignores others', all.every(isRowKind) && !isRowKind('scale') && !isRowKind(undefined));

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll device row checks passed.');
