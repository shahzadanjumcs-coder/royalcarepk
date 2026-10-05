"use strict";
/**
 * Command executor — the admin panel writes rows into whatsapp_commands and
 * this polls + executes them. Used for pairing, logout, removal, test sends
 * and the group listing. Nothing here sends real order notifications.
 */

const { toJid, isGroupJid, prefixTestMessage, normalizePkWhatsApp } = require("./lib");

class CommandRunner {
  constructor(sb, manager) {
    this.sb = sb;
    this.manager = manager;
  }

  async claimNext() {
    const { data: candidates, error } = await this.sb
      .from("whatsapp_commands")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw error;
    const candidate = candidates?.[0];
    if (!candidate) return null;
    const { data: claimed } = await this.sb
      .from("whatsapp_commands")
      .update({ status: "processing" })
      .eq("id", candidate.id)
      .eq("status", "pending")
      .select();
    return claimed?.[0] ?? null;
  }

  async finish(id, status, result) {
    await this.sb
      .from("whatsapp_commands")
      .update({ status, result: result ?? null, processed_at: new Date().toISOString() })
      .eq("id", id);
  }

  async processOne() {
    const cmd = await this.claimNext();
    if (!cmd) return false;
    const payload = cmd.payload ?? {};
    try {
      switch (cmd.command) {
        case "connect": {
          const { data: account } = await this.sb.from("whatsapp_accounts").select("*").eq("id", payload.account_id).maybeSingle();
          if (!account) throw new Error("Account row no longer exists.");
          await this.manager.ensureStarted(account);
          await this.finish(cmd.id, "done", "Session started. If pairing is needed the QR appears in the admin panel within seconds.");
          break;
        }
        case "logout": {
          await this.manager.logout(payload.account_id);
          await this.finish(cmd.id, "done", "Logged out. The session was wiped — scan a new QR to reconnect.");
          break;
        }
        case "remove": {
          this.manager.remove(payload.account_id);
          await this.finish(cmd.id, "done", "Account removed and its isolated session files were wiped.");
          break;
        }
        case "test_message": {
          const normalized = normalizePkWhatsApp(payload.phone);
          if (!normalized.valid) throw new Error(normalized.reason ?? "Invalid test phone number.");
          const accountName = await this.accountName(payload.account_id);
          await this.manager.sendText(payload.account_id, toJid(normalized.digits, "customer"), prefixTestMessage(payload.message));
          await this.finish(cmd.id, "done", `Test delivered via "${accountName}" to ${normalized.digits}.`);
          break;
        }
        case "test_group": {
          const jid = String(payload.group_jid ?? "").trim();
          if (!isGroupJid(jid)) throw new Error("Invalid group JID.");
          const accountName = await this.accountName(payload.account_id);
          await this.manager.sendText(payload.account_id, jid, prefixTestMessage(payload.message));
          await this.finish(cmd.id, "done", `Test delivered via "${accountName}" to group ${jid}.`);
          break;
        }
        case "list_groups": {
          const groups = await this.manager.listGroups(payload.account_id);
          await this.finish(cmd.id, "done", JSON.stringify(groups));
          break;
        }
        case "status_sync": {
          await this.manager.reconcile();
          await this.finish(cmd.id, "done", "Sessions reconciled with the accounts table.");
          break;
        }
        default:
          await this.finish(cmd.id, "failed", `Unknown command: ${cmd.command}`);
      }
    } catch (e) {
      await this.finish(cmd.id, "failed", e.message ?? "Command failed.");
      console.error(`[bot] command ${cmd.command} failed:`, e.message);
    }
    return true;
  }

  async accountName(accountId) {
    const { data } = await this.sb.from("whatsapp_accounts").select("name").eq("id", accountId).maybeSingle();
    return data?.name ?? accountId;
  }
}

module.exports = { CommandRunner };
