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

/**
 * Parse and validate CLI flags for a script that writes by default.
 *
 * @param {object} spec
 * @param {string} spec.name - Script filename, for messages.
 * @param {string} spec.summary - One-line description.
 * @param {Array<[string, string]>} spec.flags - [flag, description] pairs.
 * @param {string} [spec.notes] - Extra lines printed under the flag list.
 * @param {boolean} [spec.writesByDefault] - True when running with no flags
 *   mutates user data. Controls only the wording of the refusal, so the message
 *   states the actual risk instead of a generic one. Scripts that preview by
 *   default and write behind --apply have the INVERTED failure: a mistyped
 *   --apply silently previews while the user believes the change landed.
 * @param {string[]} [spec.argv] - Defaults to process.argv.slice(2).
 * @returns {{has: (flag: string) => boolean, value: (flag: string, fallback?: string) => string|undefined, argv: string[]}}
 */
export function guardArgs(spec) {
  const argv = spec.argv ?? process.argv.slice(2);
  const known = new Set(spec.flags.map(([f]) => f));
  known.add('--help');
  known.add('-h');

  if (argv.includes('--help') || argv.includes('-h')) {
    const width = Math.max(...spec.flags.map(([f]) => f.length), 10);
    console.log(`${spec.name} — ${spec.summary}`);
    console.log('');
    console.log(`  node ${spec.name}${spec.flags.length ? ' [options]' : ''}`);
    console.log('');
    for (const [flag, desc] of spec.flags) console.log(`  ${flag.padEnd(width + 2)}${desc}`);
    console.log(`  ${'--help'.padEnd(width + 2)}this message`);
    if (spec.notes) { console.log(''); console.log(spec.notes); }
    process.exit(0);
  }

  // Only flag-shaped tokens are validated; positional arguments are left to the
  // caller, which knows whether it takes any.
  const unknown = argv.filter(a => a.startsWith('-') && !known.has(a) && !/^-?\d/.test(a));
  // A flag that takes a value ("--min-threshold 3") must not have its value
  // treated as an unknown flag; values are not flag-shaped, so they never are.
  if (unknown.length > 0) {
    console.error(`${spec.name}: unrecognised argument(s): ${unknown.join(', ')}`);
    console.error(spec.writesByDefault === false
      // Without this, a typo'd --apply is indistinguishable from omitting it:
      // the script previews, reports success, and changes nothing.
      ? 'Refusing to run — a mistyped flag would silently preview instead of applying. Try --help.'
      : 'Refusing to run — this script writes by default. Try --help.');
    process.exit(2);
  }

  return {
    has: (flag) => argv.includes(flag),
    value: (flag, fallback) => {
      const i = argv.indexOf(flag);
      return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
    },
    argv,
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
