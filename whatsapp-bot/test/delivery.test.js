"use strict";
/**
 * Delivery-pipeline evidence tests (node --test, no network, no WhatsApp).
 *
 * Proves the two end-to-end guarantees that were previously missing:
 *  1. a queue message is only marked SENT when the real send function
 *     resolves, and the returned WhatsApp message id is stored as evidence
 *  2. a recipient with no WhatsApp account fails NON-retryable, a timeout
 *     fails retryable, and rows abandoned in "processing" get requeued
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { withTimeout, recipientNotOnWhatsApp } = require("../src/lib");
const { QueueProcessor } = require("../src/queue");

// ---------------------------------------------------------------------------
// withTimeout / recipientNotOnWhatsApp primitives
// ---------------------------------------------------------------------------

test("withTimeout resolves with the underlying value when fast enough", async () => {
  const result = await withTimeout(Promise.resolve("ok"), 1000, "unit");
  assert.equal(result, "ok");
});

test("withTimeout rejects when the send hangs (zombie socket guard)", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, "zombie-socket"),
    /timed out after 0s \(zombie-socket\)/i
  );
});

test("recipientNotOnWhatsApp errors are flagged non-retryable", () => {
  const err = recipientNotOnWhatsApp("923001234567");
  assert.equal(err.nonRetryable, true);
  assert.match(err.message, /not available on WhatsApp/);
});

// ---------------------------------------------------------------------------
// Fake store: minimal supabase-js shape used by QueueProcessor
// ---------------------------------------------------------------------------

/** Build a fake supabase whose .from(table) chains route into per-table row arrays. */
function fakeSupabase(tables) {
  function makeChain(table) {
    const state = { filters: [], patch: null, op: "select" };
    const apply = (row) => state.filters.every((f) => f(row));
    const chain = {
      select() {
        return chain;
      },
      in(col, values) {
        state.filters.push((r) => values.includes(r[col]));
        return chain;
      },
      eq(col, val) {
        state.filters.push((r) => r[col] === val);
        return chain;
      },
      lte(col, val) {
        state.filters.push((r) => String(r[col]) <= val);
        return chain;
      },
      lt(col, val) {
        state.filters.push((r) => String(r[col]) < val);
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      update(patch) {
        state.op = "update";
        state.patch = patch;
        return chain;
      },
      insert(row) {
        state.op = "insert";
        state.insertRow = row;
        return chain;
      },
      // await chain -> run op
      then(resolve, reject) {
        try {
          if (state.op === "select") {
            resolve({ data: tables[table].filter(apply).map((r) => ({ ...r })), error: null });
          } else if (state.op === "insert") {
            tables[table].push({ ...state.insertRow });
            resolve({ data: { ...state.insertRow }, error: null });
          } else {
            const matched = tables[table].filter(apply);
            for (const r of matched) Object.assign(r, state.patch);
            resolve({ data: matched.map((r) => ({ ...r })), error: null });
          }
        } catch (e) {
          reject(e);
        }
      },
    };
    return chain;
  }
  return { from: makeChain };
}

/** Account manager double: isConnected per config, sendText with scripted behavior. */
function fakeManager(script) {
  return {
    isConnected: (id) => script.connectedIds.includes(id),
    sendText: async (...args) => script.sendText(...args),
  };
}

function makeProcessor(sb, manager, settings) {
  const q = new QueueProcessor(sb, manager);
  q.settings = { paused: false, failover_enabled: false, send_delay_ms: 100, max_retries: 1, ...settings };
  return q;
}

const QUEUE_ROW = {
  id: "q-1",
  order_id: "o-1",
  order_number: "ORD-1",
  notification_type: "BOOKED",
  recipient: "923001234567",
  recipient_kind: "customer",
  message: "hello",
  status: "pending",
  retry_count: 0,
  max_retries: 3,
  next_attempt_at: new Date(Date.now() - 1000).toISOString(),
  dedupe_key: "o-1:BOOKED:923001234567",
  updated_at: new Date().toISOString(),
};

test("successful send stores the WhatsApp message id and marks the row sent", async () => {
  const tables = {
    whatsapp_message_queue: [{ ...QUEUE_ROW }],
    whatsapp_routing_settings: [],
    whatsapp_accounts: [{ id: "acc-1", name: "Main", enabled: true, is_default: true }],
    whatsapp_message_logs: [],
  };
  const sb = fakeSupabase(tables);
  const manager = fakeManager({
    connectedIds: ["acc-1"],
    sendText: async () => ({ waMessageId: "WA123ABC" }),
  });
  const q = makeProcessor(sb, manager);

  const handled = await q.processOne();
  assert.equal(handled, true);
  const row = tables.whatsapp_message_queue[0];
  assert.equal(row.status, "sent");
  assert.equal(row.wa_message_id, "WA123ABC");
  assert.ok(row.sent_at, "sent_at stamped");
  const log = tables.whatsapp_message_logs[0];
  assert.equal(log.status, "sent");
  assert.equal(log.wa_message_id, "WA123ABC");
});

test("recipient without a WhatsApp account fails immediately and non-retryably", async () => {
  const tables = {
    whatsapp_message_queue: [{ ...QUEUE_ROW }],
    whatsapp_routing_settings: [],
    whatsapp_accounts: [{ id: "acc-1", name: "Main", enabled: true, is_default: true }],
    whatsapp_message_logs: [],
  };
  const sb = fakeSupabase(tables);
  const manager = fakeManager({
    connectedIds: ["acc-1"],
    sendText: async () => {
      throw recipientNotOnWhatsApp("923001234567");
    },
  });
  const q = makeProcessor(sb, manager, { max_retries: 3 });

  await q.processOne();
  const row = tables.whatsapp_message_queue[0];
  assert.equal(row.status, "failed", "no retrying — the number cannot receive messages");
  assert.match(row.failure_reason, /not available on WhatsApp/);
  assert.equal(tables.whatsapp_message_logs[0].status, "failed");
});

test("timeout failures stay retryable (connection may recover)", async () => {
  const tables = {
    whatsapp_message_queue: [{ ...QUEUE_ROW }],
    whatsapp_routing_settings: [],
    whatsapp_accounts: [{ id: "acc-1", name: "Main", enabled: true, is_default: true }],
    whatsapp_message_logs: [],
  };
  const sb = fakeSupabase(tables);
  const manager = fakeManager({
    connectedIds: ["acc-1"],
    sendText: async () => {
      const e = new Error("WhatsApp send timed out after 45s");
      e.timedOut = true;
      throw e;
    },
  });
  const q = makeProcessor(sb, manager, { max_retries: 3 });

  await q.processOne();
  const row = tables.whatsapp_message_queue[0];
  assert.equal(row.status, "retrying");
  assert.match(row.failure_reason, /timed out/);
});

test("requeueStale reclaims rows stuck in processing and leaves fresh ones alone", async () => {
  const staleUpdated = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const freshUpdated = new Date().toISOString();
  const tables = {
    whatsapp_message_queue: [
      { id: "stale-1", status: "processing", updated_at: staleUpdated },
      { id: "fresh-1", status: "processing", updated_at: freshUpdated },
      { id: "sent-1", status: "sent", updated_at: staleUpdated },
    ],
  };
  const sb = fakeSupabase(tables);
  const q = makeProcessor(sb, fakeManager({ connectedIds: [] }));

  const count = await q.requeueStale();
  assert.equal(count, 1);
  assert.equal(tables.whatsapp_message_queue[0].status, "pending"); // reclaimed
  assert.equal(tables.whatsapp_message_queue[1].status, "processing"); // in-flight, untouched
  assert.equal(tables.whatsapp_message_queue[2].status, "sent"); // never touched
});

test("no connected account never sends and keeps the row waiting for the bot", async () => {
  const tables = {
    whatsapp_message_queue: [{ ...QUEUE_ROW }],
    whatsapp_routing_settings: [],
    whatsapp_accounts: [{ id: "acc-off", name: "Dead", enabled: true, is_default: true }],
    whatsapp_message_logs: [],
  };
  const sb = fakeSupabase(tables);
  let sendCalled = 0;
  const manager = fakeManager({
    connectedIds: [],
    sendText: async () => {
      sendCalled++;
      return { waMessageId: "SHOULD-NOT-HAPPEN" };
    },
  });
  const q = makeProcessor(sb, manager);

  await q.processOne();
  assert.equal(sendCalled, 0, "send must never be attempted through a dead session");
  const row = tables.whatsapp_message_queue[0];
  // retryable on purpose: the bot may reconnect at any moment — this is the
  // "Waiting for bot" state, never a fake success
  assert.equal(row.status, "retrying");
  assert.match(row.failure_reason, /No connected WhatsApp account/);
});

test("failover disabled + no routing row -> default account is used only when live", async () => {
  const tables = {
    whatsapp_message_queue: [{ ...QUEUE_ROW }],
    whatsapp_routing_settings: [],
    whatsapp_accounts: [{ id: "acc-1", name: "Main", enabled: true, is_default: true }],
    whatsapp_message_logs: [],
  };
  const sb = fakeSupabase(tables);
  const manager = fakeManager({
    connectedIds: ["acc-1"],
    sendText: async () => ({ waMessageId: "WA-OK" }),
  });
  const q = makeProcessor(sb, manager);

  await q.processOne();
  assert.equal(tables.whatsapp_message_queue[0].status, "sent");
  assert.equal(tables.whatsapp_message_queue[0].account_id, "acc-1");
  assert.equal(tables.whatsapp_message_queue[0].account_name, "Main");
});
