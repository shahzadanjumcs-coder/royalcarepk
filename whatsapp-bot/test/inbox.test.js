"use strict";
/**
 * Unit tests for incoming-message parsing (node --test).
 *
 * Regression guard for the "incoming messages never logged" gap: the bot had
 * NO messages.upsert handler at all, so inbound WhatsApp messages were
 * received by the socket and silently discarded. These tests pin the
 * parseIncomingMessage() contract: what must be captured, what must be
 * skipped, and how JIDs/phones/timestamps are normalized.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseIncomingMessage, jidPhone } = require("../src/lib");

const ACC = "acc-1";

test("plain incoming text message is captured with normalized fields", () => {
  const row = parseIncomingMessage(ACC, {
    key: { remoteJid: "923256912201@s.whatsapp.net", fromMe: false, id: "ABC123" },
    pushName: "Shahzad",
    messageTimestamp: 1759660800,
    message: { conversation: "TEST123" },
  });
  assert.ok(row, "row must be produced");
  assert.equal(row.account_id, ACC);
  assert.equal(row.wa_message_id, "ABC123");
  assert.equal(row.chat_jid, "923256912201@s.whatsapp.net");
  assert.equal(row.chat_kind, "direct");
  assert.equal(row.sender_phone, "923256912201");
  assert.equal(row.sender_name, "Shahzad");
  assert.equal(row.body, "TEST123");
  assert.equal(row.message_type, "conversation");
  assert.equal(row.wa_timestamp, new Date(1759660800 * 1000).toISOString());
  assert.equal(row.is_from_me, false);
});

test("extendedText (reply/link preview) messages are captured", () => {
  const row = parseIncomingMessage(ACC, {
    key: { remoteJid: "923001234567@s.whatsapp.net", fromMe: false, id: "E1" },
    message: { extendedTextMessage: { text: "reply text" } },
  });
  assert.equal(row.body, "reply text");
  assert.equal(row.message_type, "extendedText");
});

test("ephemeral wrapper is unwrapped", () => {
  const row = parseIncomingMessage(ACC, {
    key: { remoteJid: "923001234567@s.whatsapp.net", fromMe: false, id: "E2" },
    message: { ephemeralMessage: { message: { conversation: "disappearing msg" } } },
  });
  assert.equal(row.body, "disappearing msg");
  assert.equal(row.message_type, "conversation");
});

test("fromMe echoes are skipped (outbound already covered by Message Logs)", () => {
  const row = parseIncomingMessage(ACC, {
    key: { remoteJid: "923001234567@s.whatsapp.net", fromMe: true, id: "M1" },
    message: { conversation: "my own outgoing" },
  });
  assert.equal(row, null);
});

test("status broadcasts are skipped", () => {
  const row = parseIncomingMessage(ACC, {
    key: { remoteJid: "status@broadcast", fromMe: false, id: "S1" },
    message: { conversation: "status update" },
  });
  assert.equal(row, null);
});

test("protocol/empty payloads produce nothing", () => {
  assert.equal(
    parseIncomingMessage(ACC, {
      key: { remoteJid: "923001234567@s.whatsapp.net", fromMe: false, id: "P1" },
      message: { protocolMessage: { type: 0 } },
    }),
    null
  );
  assert.equal(
    parseIncomingMessage(ACC, {
      key: { remoteJid: "923001234567@s.whatsapp.net", fromMe: false, id: "P2" },
      message: {},
    }),
    null
  );
});

test("messages without key.id or remoteJid are skipped (cannot dedup/route)", () => {
  assert.equal(parseIncomingMessage(ACC, { message: { conversation: "x" } }), null);
  assert.equal(
    parseIncomingMessage(ACC, { key: { fromMe: false, id: "X" }, message: { conversation: "x" } }),
    null
  );
});

test("group messages use key.participant as the sender and keep the group chat jid", () => {
  const row = parseIncomingMessage(ACC, {
    key: {
      remoteJid: "12036302121234-1555123456@g.us",
      fromMe: false,
      id: "G1",
      participant: "923334455667:14@s.whatsapp.net",
    },
    message: { conversation: "hello group" },
  });
  assert.equal(row.chat_kind, "group");
  assert.equal(row.chat_jid, "12036302121234-1555123456@g.us");
  assert.equal(row.sender_jid, "923334455667:14@s.whatsapp.net");
  assert.equal(row.sender_phone, "923334455667"); // device suffix ":14" stripped
});

test("LID-format JIDs are never dropped — raw jid kept, digits extracted", () => {
  const row = parseIncomingMessage(ACC, {
    key: { remoteJid: "113498152771234@lid", fromMe: false, id: "L1" },
    message: { conversation: "lid message" },
  });
  assert.ok(row, "LID message must still be captured");
  assert.equal(row.chat_jid, "113498152771234@lid");
  assert.equal(row.sender_phone, "113498152771234");
});

test("captioned media captures the caption; uncaptioned media get a placeholder", () => {
  const caption = parseIncomingMessage(ACC, {
    key: { remoteJid: "923001234567@s.whatsapp.net", fromMe: false, id: "C1" },
    message: { imageMessage: { caption: "photo caption" } },
  });
  assert.equal(caption.body, "photo caption");
  assert.equal(caption.message_type, "image");

  const img = parseIncomingMessage(ACC, {
    key: { remoteJid: "923001234567@s.whatsapp.net", fromMe: false, id: "C2" },
    message: { imageMessage: { url: "x" } },
  });
  assert.equal(img.body, "[image]");
  assert.equal(img.message_type, "image");
});

test("jidPhone strips device suffixes and tolerates junk", () => {
  assert.equal(jidPhone("923001234567:12@s.whatsapp.net"), "923001234567");
  assert.equal(jidPhone("923001234567@s.whatsapp.net"), "923001234567");
  assert.equal(jidPhone(""), null);
  assert.equal(jidPhone(null), null);
});
