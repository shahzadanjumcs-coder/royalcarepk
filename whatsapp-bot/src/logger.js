"use strict";
/**
 * Pino wrapper used as Baileys' internal logger.
 *
 * Baileys logs some NON-FATAL transient errors at error level — most notably
 * "unexpected error in 'init queries'" (Boom 'Timed Out', statusCode 408)
 * right after a session connects on a slow/unstable network. The socket stays
 * open and usable, but on flaky networks the same line repeats on every
 * reconnect cycle and looks like a crash loop. This wrapper keeps every error
 * visible while collapsing IDENTICAL (msg + message + statusCode) repeats to
 * one line per 10-minute window, so logs stay calm and readable.
 */
const pino = require("pino");

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED = 500;

function createBotLogger(level = "error") {
  const base = pino({ level });
  const seen = new Map();

  const shouldLog = (binding, msg) => {
    const err = binding && typeof binding === "object" ? binding.err ?? binding : null;
    const key = `${msg ?? ""}::${err?.message ?? ""}::${err?.output?.statusCode ?? ""}`;
    const now = Date.now();
    const prev = seen.get(key) ?? 0;
    if (now - prev < DEDUPE_WINDOW_MS) return false;
    // keep the map bounded: drop expired entries, then hard-reset if needed
    if (seen.size > MAX_TRACKED) {
      for (const [k, t] of seen) if (now - t >= DEDUPE_WINDOW_MS) seen.delete(k);
      if (seen.size > MAX_TRACKED) seen.clear();
    }
    seen.set(key, now);
    return true;
  };

  const wrap = (target) => ({
    level: target.level,
    child: (bindings) => wrap(target.child(bindings)),
    trace: (...args) => target.trace(...args),
    debug: (...args) => target.debug(...args),
    info: (...args) => target.info(...args),
    warn: (...args) => target.warn(...args),
    error: (binding, msg, ...rest) => {
      if (shouldLog(binding, msg)) target.error(binding, msg, ...rest);
    },
    fatal: (...args) => target.fatal(...args),
  });

  return wrap(base);
}

module.exports = { createBotLogger, DEDUPE_WINDOW_MS };
