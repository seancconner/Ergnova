// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * storage/profile-backup-flow.js
 *
 * What Settings → Backup & Restore's Export and Import buttons DO, as two async
 * functions with every touch of the page passed in — so the decisions in them
 * (refuse while a workout is running, what to say when the file is wrong, when to
 * ask for confirmation, what a half-finished import leaves behind and how it says
 * so) are smoke-tested in plain node (__profile_backup_flow_smoketest__.js)
 * instead of only ever exercised by tapping through the app.
 *
 * The layering, top to bottom:
 *   storage/profile-archive.js   the file format, validation, duplicate rules, message text
 *   storage/profile-transfer.js  reads/writes IndexedDB in the right order (db is injected)
 *   this file                    the button flows: pick -> preview -> confirm -> write -> refresh -> message
 *   app.js                       supplies the hooks below (the real file picker, confirm(), the
 *                                status line, view refresh) and binds the buttons
 *
 * Hooks (all injected, so none of this file touches the DOM):
 *   db                  storage/db.js's `db`
 *   saveFile            platform/save-file.js's saveFile(filename, blob) -> Promise<boolean>
 *   pickTextFile        platform/pick-file.js's pickTextFile() -> Promise<{name,text}|null>
 *   confirm             (text) => boolean — window.confirm in the app
 *   isWorkoutRunning    () => boolean — an import is refused while one is (it would swap the FTP, units
 *                       and rider weight out from under a live ERG/slope session, and re-read history the
 *                       session is about to append to)
 *   setStatus           (text, { error }) => void — the one-line result under the buttons; '' clears it
 *   setBusy             (busy) => void — lock/unlock the two buttons
 *   refreshAfterImport  async ({ plan, prefsRestored }) => void — reload whatever caches or views show
 *                       imported data. Its failures are logged, never reported as a failed import: by
 *                       then the data is already in.
 *   now                 optional clock (ms), for the export filename; tests only
 *
 * Each function resolves with a short outcome string — for the tests, and so a caller could react —
 * and never rejects.
 */

import {
  profileImportConfirmText, profileImportSummary, profileImportErrorMessage,
  profileExportSummary, profileImportFailureMessage,
} from './profile-archive.js';
import { exportProfile, prepareProfileImport, applyProfileImport } from './profile-transfer.js';

export const WORKOUT_BLOCKS_IMPORT_MESSAGE = 'Finish or stop your workout before importing a backup.';

/**
 * @returns {{
 *   exportBackup: () => Promise<'exported'|'not-saved'|'nothing-to-export'|'failed'|'busy'>,
 *   importBackup: () => Promise<'imported'|'partial'|'failed'|'nothing-new'|'declined'|'refused'|'cancelled'|'unreadable'|'blocked'|'busy'>,
 * }}
 */
export function createProfileBackupFlow({
  db, saveFile, pickTextFile, confirm,
  isWorkoutRunning = () => false,
  setStatus = () => {},
  setBusy = () => {},
  refreshAfterImport = async () => {},
  now,
}) {
  // Locks Import/Export while one of them is working — deliberately not while the file picker is open,
  // since a picker that never reports back (see platform/pick-file.js) would leave them stuck.
  let busy = false;
  const lock = (on) => { busy = on; setBusy(on); };

  async function refresh(plan, prefsRestored) {
    try {
      await refreshAfterImport({ plan, prefsRestored });
    } catch (err) {
      console.error('[profile] refreshing after import failed', err);
    }
  }

  async function exportBackup() {
    if (busy) return 'busy';
    lock(true);
    try {
      const { json, counts, settingsCount, filename } = await exportProfile(db, now == null ? {} : { now });
      if (!settingsCount && Object.values(counts).every((n) => !n)) {
        setStatus('Nothing to export yet.');
        return 'nothing-to-export';
      }
      const saved = await saveFile(filename, new Blob([json], { type: 'application/json' }));
      setStatus(saved ? profileExportSummary(counts, { settingsCount }) : 'The export wasn\u2019t saved.');
      return saved ? 'exported' : 'not-saved';
    } catch (err) {
      console.error('[profile] export failed', err);
      setStatus('Couldn\u2019t export your profile.', { error: true });
      return 'failed';
    } finally {
      lock(false);
    }
  }

  async function importBackup() {
    if (busy) return 'busy';
    if (isWorkoutRunning()) {
      setStatus(WORKOUT_BLOCKS_IMPORT_MESSAGE, { error: true });
      return 'blocked';
    }

    let picked;
    try {
      picked = await pickTextFile();
    } catch (err) {
      console.error('[profile] reading the picked file failed', err);
      setStatus('Couldn\u2019t read that file.', { error: true });
      return 'unreadable';
    }
    if (!picked) return 'cancelled';

    lock(true);
    let plan = null;
    let restoreSettings = false;
    try {
      const prep = await prepareProfileImport(db, picked.text);
      if (!prep.ok) {
        setStatus(profileImportErrorMessage(prep.error), { error: true });
        return 'refused';
      }
      plan = prep.plan;
      if (!prep.addCount && !prep.hasSettings) {
        setStatus(profileImportSummary(plan, { invalid: prep.parsed.invalid }));
        return 'nothing-new';
      }
      if (!confirm(profileImportConfirmText(plan, { replacesSettings: prep.hasSettings }))) {
        setStatus('');
        return 'declined';
      }
      // The native picker (and the confirm) can sit open for a while: look again right before writing.
      if (isWorkoutRunning()) {
        setStatus(WORKOUT_BLOCKS_IMPORT_MESSAGE, { error: true });
        return 'blocked';
      }

      restoreSettings = prep.hasSettings;
      const applied = await applyProfileImport(db, plan, { prefs: prep.parsed.data.prefs, restoreSettings });
      await refresh(plan, applied.prefsRestored);
      setStatus(profileImportSummary(plan, { prefsRestored: applied.prefsRestored, invalid: prep.parsed.invalid }));
      return 'imported';
    } catch (err) {
      console.error('[profile] import failed', err);
      const importedSoFar = err?.importedSoFar ?? [];
      // Categories are written one at a time, so an earlier one may already be in: show it, and say so.
      if (plan && importedSoFar.length) await refresh(plan, false);
      setStatus(
        plan ? profileImportFailureMessage(plan, importedSoFar, { settingsPending: restoreSettings })
             : 'Couldn\u2019t import that file. Nothing was changed.',
        { error: true },
      );
      return importedSoFar.length ? 'partial' : 'failed';
    } finally {
      lock(false);
    }
  }

  return { exportBackup, importBackup };
}
