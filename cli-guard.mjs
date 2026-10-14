// @ts-check
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';
import { resolve } from 'path';

// Argument guard for scripts whose default action writes to user data.
//
// WHY THIS EXISTS
// `node dedup-tracker.mjs --help` did not print help. The flag was simply not
// recognised, argument parsing ignored it, and the script proceeded to its
// default action — a destructive rewrite of data/applications.md — deleting two
// tracker rows (2026-08-12). Every writing script in this repo had the same
// shape: flags read with `argv.includes(...)`, anything unrecognised silently
// ignored.
//
// A typo (`--dryrun`, `--dry_run`, `--drу-run` with a Cyrillic у) therefore
// reads as "no flags" and runs the real thing. For a script that rewrites the
// user's tracker, that is the worst possible default.
//
// The rule: on a script that writes, an argument you did not understand is a
// reason to STOP, not to continue with defaults.
//
// Every argument is therefore accounted for, not only the flag-shaped ones. A flag
// DECLARES whether it takes a value, so the guard never has to guess whether the
// token after it is that value or a stray argument, and a script takes no bare
// arguments unless it says so.

// A flag is `-x` or `--word`. "-1" and "-" are not flags; they are bare arguments.
const FLAG = /^--?[A-Za-z]/;

/**
 * Parse and validate the CLI arguments of a script that writes.
 *
 * @param {object} spec
 * @param {string} spec.name - Script filename, for messages ("tracker.mjs query" for a
 *   subcommand).
 * @param {string} spec.summary - One-line description.
 * @param {Array<[string, string]>} spec.flags - [flag, description] pairs. A flag that
 *   takes a value names it after a space, `--company <name>`, and accepts both
 *   `--company X` and `--company=X`. An optional value is written `--throttle[=<ms>]`
 *   and can only be given with `=`, since a bare `--throttle` must not swallow the
 *   argument after it. Any other flag is a switch and refuses `=value`.
 * @param {string} [spec.positional] - Opt-in for a script that takes bare arguments
 *   (files, a JD text): names them for the usage line. Without it, any bare argument
 *   is refused.
 * @param {string} [spec.notes] - Extra lines printed under the flag list.
 * @param {boolean} [spec.writesByDefault] - True when running with no flags
 *   mutates user data. Controls only the wording of the refusal, so the message
 *   states the actual risk instead of a generic one. Scripts that preview by
 *   default and write behind --apply have the INVERTED failure: a mistyped
 *   --apply silently previews while the user believes the change landed.
 * @param {string[]} [spec.argv] - Defaults to process.argv.slice(2).
 * @returns {{has: (flag: string) => boolean,
 *   value: (flag: string, fallback?: string) => string|undefined,
 *   positional: string[]}}
 */
export function guardArgs(spec) {
  const argv = spec.argv ?? process.argv.slice(2);
  /** @type {Map<string, 'switch'|'value'|'optional'>} */
  const kinds = new Map(spec.flags.map(([decl]) => [decl.split(/[\s[=]/)[0],
    decl.includes('[=') ? 'optional' : /\s/.test(decl) ? 'value' : 'switch']));

  if (argv.includes('--help') || argv.includes('-h')) {
    const width = Math.max(...spec.flags.map(([f]) => f.length), 10);
    console.log(`${spec.name} — ${spec.summary}`);
    console.log('');
    console.log(`  node ${spec.name}${spec.flags.length ? ' [options]' : ''}`
      + `${spec.positional ? ` ${spec.positional}` : ''}`);
    console.log('');
    for (const [flag, desc] of spec.flags) console.log(`  ${flag.padEnd(width + 2)}${desc}`);
    console.log(`  ${'--help'.padEnd(width + 2)}this message`);
    if (spec.notes) { console.log(''); console.log(spec.notes); }
    process.exit(0);
  }

  /** @type {Map<string, string|true>} */
  const given = new Map();
  const positional = [];
  const unknown = [];
  const valueless = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!FLAG.test(a)) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const kind = kinds.get(flag);
    if (!kind || (kind === 'switch' && eq !== -1)) { unknown.push(a); continue; }
    /** @type {string|true} */
    let v = true;
    if (eq !== -1) v = a.slice(eq + 1);
    else if (kind === 'value') {
      if (i + 1 < argv.length && !FLAG.test(argv[i + 1])) v = argv[++i];
      else { valueless.push(flag); continue; }
    }
    if (!given.has(flag)) given.set(flag, v);
  }
  if (!spec.positional) unknown.push(...positional);

  if (unknown.length || valueless.length) {
    if (unknown.length) console.error(`${spec.name}: unrecognised argument(s): ${unknown.join(', ')}`);
    for (const f of valueless) console.error(`${spec.name}: ${f} needs a value`);
    console.error(spec.writesByDefault === false
      // Without this, a typo'd --apply is indistinguishable from omitting it:
      // the script previews, reports success, and changes nothing.
      ? 'Refusing to run — a mistyped flag would silently preview instead of applying. Try --help.'
      : 'Refusing to run — this script writes by default. Try --help.');
    process.exit(2);
  }

  return {
    has: (flag) => given.has(flag),
    value: (flag, fallback) => {
      const v = given.get(flag);
      return typeof v === 'string' ? v : fallback;
    },
    positional,
  };
}

/**
 * Check whether this module was invoked directly (not imported).
 * Handles symlinks and junctions by resolving to real paths on both sides.
 *
 * @param {string} importMetaUrl - The value of import.meta.url from the caller.
 * @returns {boolean} True if this module is the entry point.
 */
export function isMain(importMetaUrl) {
  try {
    return !!process.argv[1]
      && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
