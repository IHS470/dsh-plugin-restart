/**
 * The plugin's settings: defaults, validation, and the file they live in.
 *
 * Kept apart from the Host so the shape of what a user can change is one readable list rather than
 * something inferred from route handlers — and so every value is validated in exactly one place. Anything
 * a request cannot justify is dropped in favour of what was already there, because a settings file that
 * says "quit: banana" must not be able to stop a restart from working.
 */
import fs from 'node:fs'

/** What an untouched install uses. Graceful quit is the default: "it really closed" matters more than fast. */
export const DEFAULTS = Object.freeze({
  /** `graceful` waits for the whole previous generation to leave on its own; `force` closes it outright. */
  quit: 'graceful',
  /** Where the restart button lives: next to the caption buttons on either side, or only in Settings. */
  button: 'right',
  /** Pixels added to that side's natural offset — negative pulls it towards the middle of the title bar. */
  offset: 0,
  /** Whether the shell that was started is checked for a window: `auto` raises it when missing. */
  window: 'auto',
  /** How long the app must keep answering before a restart counts as finished (milliseconds). */
  settleMs: 6000,
})

const QUIT_VALUES = ['graceful', 'force']
const BUTTON_VALUES = ['right', 'left', 'settings']
const WINDOW_VALUES = ['auto', 'always', 'report']

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

/** One value, or the fallback when it is not something this plugin recognises. */
function pick(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/**
 * The settings a request asks for, on top of what is already stored.
 *
 * @param input - Whatever the request body carried; anything not an object is ignored.
 * @param current - The settings in force; a field the request does not mention keeps its value.
 * @returns A complete, valid settings object.
 */
export function normalize(input, current = DEFAULTS) {
  const base = { ...DEFAULTS, ...(current ?? {}) }
  const raw = input !== null && typeof input === 'object' ? input : {}
  const number = (value, fallback, low, high) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? clamp(Math.round(parsed), low, high) : fallback
  }
  return {
    quit: 'quit' in raw ? pick(raw.quit, QUIT_VALUES, base.quit) : base.quit,
    button: 'button' in raw ? pick(raw.button, BUTTON_VALUES, base.button) : base.button,
    offset: 'offset' in raw ? number(raw.offset, base.offset, -600, 600) : base.offset,
    window: 'window' in raw ? pick(raw.window, WINDOW_VALUES, base.window) : base.window,
    settleMs: 'settleMs' in raw ? number(raw.settleMs, base.settleMs, 0, 120_000) : base.settleMs,
  }
}

/** The stored settings, or the defaults when the file is missing, unreadable or not an object. */
export function readSettings(file) {
  if (file === undefined) return { ...DEFAULTS }
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

/** Store settings, and report the complete object that is now in force. */
export function writeSettings(file, input) {
  const next = normalize(input, readSettings(file))
  try {
    fs.writeFileSync(file, `${JSON.stringify(next, undefined, 2)}\n`)
  } catch {
    // A settings file that cannot be written is not a reason to refuse the change: it still applies to
    // this run, and the next one falls back to the defaults.
  }
  return next
}
