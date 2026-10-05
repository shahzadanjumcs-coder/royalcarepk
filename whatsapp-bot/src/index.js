"use strict";
/**
 * RoyalCarePK WhatsApp bot — entry point.
 *
 * A separate, always-on Node.js service (run on your own PC / VPS — NEVER on
 * Vercel serverless). It polls Supabase for:
 *   1. admin commands  (pair / logout / remove / test / list groups)
 *   2. queued messages (real order notifications, sent one by one)
 * and keeps the configured WhatsApp Web sessions alive with auto-reconnect.
 *
 * If this bot is stopped, RoyalCarePK keeps working normally — notifications
 * simply stay queued and are sent when the bot comes back.
 */

require("dotenv").config();
const http = require("node:http");
const path = require("node:path");

const { createSupabase, touchBotHeartbeat } = require("./store");
const { AccountManager } = require("./accounts");
const { QueueProcessor } = require("./queue");
const { CommandRunner } = require("./commands");
const { sleep, isTransientBaileysError } = require("./lib");

const POLL_MS = Number(process.env.WHATSAPP_POLL_MS) || 3000;
const HEARTBEAT_MS = 15 * 1000;
const RECONCILE_MS = 15 * 1000;
const SEND_DELAY_DEFAULT = Number(process.env.WHATSAPP_SEND_DELAY_MS) || 2500;
const HEALTH_PORT = Number(process.env.PORT) || 3088;
const SESSION_DIR = path.resolve(__dirname, "..", process.env.WHATSAPP_SESSION_DIR || "./sessions");

const startedAt = new Date();
const stats = { commands: 0, sent: 0, failed: 0, lastError: null };

/**
 * Baileys internals can surface stray async errors (transient 408 timeouts,
 * dropped frames, …). Node >= 15 turns an unhandled rejection into a hard
 * exit, which would kill EVERY account plus command/queue polling. Instead:
 * log, classify and stay alive — dead sockets self-heal via the close →
 * reconnect loop and reconcile(), and stored sessions are never touched.
 */
process.on("unhandledRejection", (reason) => {
  stats.lastError = reason?.message ?? String(reason);
  console.error(`[bot] unhandled rejection (kept alive${isTransientBaileysError(reason) ? ", transient" : ""}): ${stats.lastError}`);
});
process.on("uncaughtException", (err) => {
  stats.lastError = err?.message ?? String(err);
  console.error(`[bot] uncaught exception (kept alive${isTransientBaileysError(err) ? ", transient" : ""}):`, err?.stack ?? err);
});

async function main() {
  const sb = createSupabase();
  const manager = new AccountManager(sb, SESSION_DIR);
  const queue = new QueueProcessor(sb, manager);
  const commands = new CommandRunner(sb, manager);

  console.log(`RoyalCarePK WhatsApp bot starting — sessions in ${SESSION_DIR}`);

  // initial reconciliation: bring every enabled account online
  await manager.reconcile().catch((e) => console.error("[bot] initial reconcile:", e.message));

  // command loop (pairing, tests, group listing)
  (async function commandLoop() {
    for (;;) {
      try {
        const acted = await commands.processOne();
        if (acted) stats.commands++;
        await sleep(acted ? 250 : POLL_MS);
      } catch (e) {
        stats.lastError = e.message;
        console.error("[bot] command loop:", e.message);
        await sleep(5000);
      }
    }
  })();

  // queue loop (real notifications; sequential + delay = responsible rate)
  (async function queueLoop() {
    for (;;) {
      try {
        const settings = await queue.refreshSettings();
        if (settings.paused) {
          await sleep(POLL_MS);
          continue;
        }
        const acted = await queue.processOne();
        if (acted) {
          stats.sent++;
          await sleep(Math.max(500, settings.send_delay_ms || SEND_DELAY_DEFAULT));
        } else {
          await sleep(POLL_MS);
        }
      } catch (e) {
        stats.lastError = e.message;
        stats.failed++;
        console.error("[bot] queue loop:", e.message);
        await sleep(5000);
      }
    }
  })();

  // heartbeat + reconcile loops
  (async function heartbeatLoop() {
    for (;;) {
      try {
        await touchBotHeartbeat(sb);
        await manager.heartbeat();
      } catch (e) {
        console.error("[bot] heartbeat:", e.message);
      }
      await sleep(HEARTBEAT_MS);
    }
  })();
  (async function reconcileLoop() {
    for (;;) {
      try {
        await manager.reconcile();
      } catch (e) {
        console.error("[bot] reconcile:", e.message);
      }
      await sleep(RECONCILE_MS);
    }
  })();

  // tiny health endpoint for pm2 / monitoring
  if (HEALTH_PORT > 0) {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          uptime_s: Math.round((Date.now() - startedAt.getTime()) / 1000),
          sessions: [...manager.socks.keys()],
          stats,
        })
      );
    });
    server.listen(HEALTH_PORT, () => console.log(`[bot] health endpoint on http://127.0.0.1:${HEALTH_PORT}`));
  }

  const shutdown = async (signal) => {
    console.log(`\n[bot] ${signal} received — closing WhatsApp sessions…`);
    await manager.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
