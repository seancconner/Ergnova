// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * formats/format-registry.js
 *
 * Defines the common interface every format module must implement and
 * maintains a lookup table by file extension and MIME type.
 *
 * Adding a new format later is a single registry.register() call —
 * nothing else in the app needs to change.
 *
 * Interface every format module must export:
 *   parse(text: string)  -> WorkoutModel
 *   write(model: WorkoutModel) -> string
 *   EXTENSIONS: string[]    e.g. ['.zwo']
 *   MIME_TYPES:  string[]   e.g. ['application/xml']
 *
 * Usage:
 *   import { registry } from './formats/format-registry.js';
 *   const model  = registry.parse(fileText, '.zwo');
 *   const output = registry.write(model, '.zwo');
 *   const fmt    = registry.formatForFile('my-workout.fit');
 */

// ─── Registry internals ───────────────────────────────────────────────────────

const _byExtension = new Map();   // '.zwo' -> formatModule
const _byMime      = new Map();   // 'application/xml' -> formatModule
const _formats     = new Map();   // 'zwo' -> formatModule  (by canonical name)

// ─── Validation ───────────────────────────────────────────────────────────────

function _validate(mod, name) {
  const required = ['parse', 'write', 'EXTENSIONS', 'MIME_TYPES'];
  for (const key of required) {
    if (!(key in mod)) {
      throw new Error(`[format-registry] Format "${name}" is missing export: ${key}`);
    }
  }
  if (typeof mod.parse !== 'function') throw new Error(`"${name}".parse must be a function`);
  if (typeof mod.write !== 'function') throw new Error(`"${name}".write must be a function`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const registry = {

  /**
   * Register a format module.
   *
   * @param {string} name    Canonical name, e.g. 'zwo', 'fit-workout'
   * @param {Object} mod     Module with { parse, write, EXTENSIONS, MIME_TYPES }
   */
  register(name, mod) {
    _validate(mod, name);
    _formats.set(name, mod);
    for (const ext  of mod.EXTENSIONS) _byExtension.set(ext.toLowerCase(), mod);
    for (const mime of mod.MIME_TYPES)  _byMime.set(mime.toLowerCase(), mod);
    console.debug(`[format-registry] Registered format: ${name}`);
  },

  /**
   * Look up a format by file extension (e.g. '.zwo') or MIME type.
   * Returns null if not found.
   *
   * @param {string} hint   Extension (with dot) or MIME type string.
   * @returns {Object|null}
   */
  formatFor(hint) {
    const h = hint.toLowerCase();
    return _byExtension.get(h) ?? _byMime.get(h) ?? null;
  },

  /**
   * Infer format from a filename and return the module.
   * e.g. 'my-ride.zwo' → zwo module
   *
   * @param {string} filename
   * @returns {Object|null}
   */
  formatForFile(filename) {
    const ext = '.' + filename.split('.').pop().toLowerCase();
    return this.formatFor(ext);
  },

  /**
   * Parse file text into a WorkoutModel using the format for the given extension.
   *
   * @param {string} text       Raw file contents.
   * @param {string} extOrMime  e.g. '.zwo' or 'application/xml'
   * @returns {import('../core/cardio-model.js').WorkoutModel}
   */
  parse(text, extOrMime) {
    const fmt = this.formatFor(extOrMime);
    if (!fmt) throw new Error(`[format-registry] No parser for: ${extOrMime}`);
    return fmt.parse(text);
  },

  /**
   * Serialize a WorkoutModel to the given format.
   *
   * @param {import('../core/cardio-model.js').WorkoutModel} model
   * @param {string} extOrMime
   * @returns {string}
   */
  write(model, extOrMime) {
    const fmt = this.formatFor(extOrMime);
    if (!fmt) throw new Error(`[format-registry] No writer for: ${extOrMime}`);
    return fmt.write(model);
  },

  /**
   * Returns an array of all registered format names.
   * @returns {string[]}
   */
  registeredFormats() {
    return [..._formats.keys()];
  },

  /**
   * Returns the list of all known file extensions (for <input accept=""> etc.)
   * @returns {string[]}
   */
  acceptedExtensions() {
    return [..._byExtension.keys()];
  },
};

export default registry;
