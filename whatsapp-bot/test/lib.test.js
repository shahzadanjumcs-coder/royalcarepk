"use strict";
/** Unit tests for the dependency-free bot helpers (node --test). */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePkWhatsApp,
  renderTemplate,
  computeBackoffMs,
  prefixTestMessage,
  isGroupJid,
  isTransientBaileysError,
} = require("../src/lib");

test("normalizePkWhatsApp maps PK formats to 92XXXXXXXXXX", () => {
  assert.deepEqual(normalizePkWhatsApp("03001234567"), { valid: true, digits: "923001234567" });
  assert.deepEqual(normalizePkWhatsApp("+92 300 1234567"), { valid: true, digits: "923001234567" });
  assert.equal(normalizePkWhatsApp("923001234567").valid, true);
  assert.equal(normalizePkWhatsApp("00923001234567").valid, true);
  assert.equal(normalizePkWhatsApp("0301234567").valid, false); // 10 digits — not a PK mobile
  assert.equal(normalizePkWhatsApp("").valid, false);
});

test("renderTemplate substitutes known vars and keeps unknown placeholders", () => {
  assert.equal(renderTemplate("Hi {{name}}, order {{order_number}}", { name: "Ali", order_number: "RC-1" }), "Hi Ali, order RC-1");
  assert.equal(renderTemplate("Hi {{missing}}", {}), "Hi {{missing}}");
});

test("computeBackoffMs grows exponentially and caps at 10 minutes", () => {
  assert.equal(computeBackoffMs(0), 30000);
  assert.equal(computeBackoffMs(1), 60000);
  assert.equal(computeBackoffMs(10), 10 * 60 * 1000);
});

test("prefixTestMessage always tags test sends", () => {
  assert.ok(prefixTestMessage("hello").startsWith("[RoyalCarePK TEST]"));
  assert.equal(prefixTestMessage("[RoyalCarePK TEST] hello"), "[RoyalCarePK TEST] hello");
});

test("isGroupJid accepts only group JIDs", () => {
  assert.equal(isGroupJid("12036302121234-1555123456@g.us"), true);
  assert.equal(isGroupJid("923001234567@s.whatsapp.net"), false);
  assert.equal(isGroupJid("nope"), false);
});

test("isTransientBaileysError classifies 408 init-query timeouts as transient", () => {
  assert.equal(isTransientBaileysError({ output: { statusCode: 408 }, message: "Timed Out" }), true);
  assert.equal(isTransientBaileysError(new Error("Timed Out")), true);
  assert.equal(isTransientBaileysError({ message: "Connection Closed" }), true);
  assert.equal(isTransientBaileysError({ output: { statusCode: 515 } }), true); // restartRequired
  assert.equal(isTransientBaileysError(new Error("fetch failed")), true);
  assert.equal(isTransientBaileysError(null), false);
  assert.equal(isTransientBaileysError(undefined), false);
  // loggedOut must NOT count as transient — that path wipes the session
  assert.equal(isTransientBaileysError({ output: { statusCode: 401 }, message: "Unauthorized" }), false);
  assert.equal(isTransientBaileysError(new Error("totally unrelated")), false);
});
