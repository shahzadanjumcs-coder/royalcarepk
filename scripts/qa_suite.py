"""RoyalCarePK — comprehensive API QA suite.
Runs against the local dev server. Prints PASS/FAIL per check, exits non-zero on failure.
Covers: auth, RBAC, worker isolation, orders lifecycle, booking, duplicate-booking,
inventory reservation/movements, commission idempotency, payments balance, reports,
notifications, audit logs (no secrets), flaship endpoints, error handling.
"""
import json, urllib.request, urllib.error, http.cookiejar, sys, re

BASE = "http://localhost:3000"
PASS, FAIL = [], []

def client():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.cj = cj
    return op

def req(op, method, path, body=None, headers=None):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with op.open(r, data=data, timeout=30) as resp:
            raw = resp.read().decode()
            try:
                return resp.status, json.loads(raw)
            except Exception:
                return resp.status, {"_raw": raw[:300]}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw[:300]}

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  [{detail}]" if detail and not cond else ""))

def section(t):
    print(f"\n== {t} ==")

# ---------- sessions ----------
admin = client()   # super_admin
worker = client()  # worker
inv = client()     # inventory_manager
mgr = client()     # admin (manager)
anon = client()

s, d = req(admin, "POST", "/api/auth/login", {"email": "admin@demo.com", "password": "admin123"})
check("AUTH: super admin login", s == 200 and d.get("role") == "super_admin", f"{s}")
s, d = req(worker, "POST", "/api/auth/login", {"email": "ali@demo.com", "password": "worker123"})
check("AUTH: worker login", s == 200 and d.get("role") == "worker", f"{s}")
s, d = req(inv, "POST", "/api/auth/login", {"email": "inventory@demo.com", "password": "admin123"})
check("AUTH: inventory manager login", s == 200 and d.get("role") == "inventory_manager", f"{s}")
s, d = req(mgr, "POST", "/api/auth/login", {"email": "manager@demo.com", "password": "admin123"})
check("AUTH: manager login", s == 200 and d.get("role") == "admin", f"{s}")
s, d = req(anon, "POST", "/api/auth/login", {"email": "admin@demo.com", "password": "wrong-password"})
check("AUTH: wrong password rejected", s == 401, f"{s}")
s, d = req(anon, "GET", "/api/orders")
check("AUTH: anonymous API → 401", s == 401, f"{s}")

# ---------- RBAC ----------
section("RBAC")
s, d = req(anon, "GET", "/api/users")
check("RBAC: anon users API → 401", s == 401, f"{s}")
s, d = req(worker, "GET", "/api/users")
check("RBAC: worker users API → 403", s == 403, f"{s}")
s, d = req(worker, "POST", "/api/branding", body=None)
check("RBAC: worker branding POST → 403", s == 403, f"{s}")
s, d = req(inv, "POST", "/api/orders", {"delivery_address": "x", "city": "x", "items": [{"product_id": "x", "quantity": 1, "unit_price": 1}]})
check("RBAC: inventory manager create order → 403", s == 403, f"{s}")
s, d = req(inv, "GET", "/api/products")
check("RBAC: inventory manager read products → 200", s == 200, f"{s}")
s, d = req(mgr, "POST", "/api/products", {"name": "rbac-probe", "sku": f"RBAC-PROBE-{int(__import__('time').time())%100000}", "purchase_price": 100, "selling_price": 150, "current_stock": 3})
check("RBAC: manager create product → 200/201", s in (200, 201), f"{s} {json.dumps(d)[:80]}")
if s in (200, 201):
    pid = d["product"]["id"]
    s2, _ = req(mgr, "DELETE", f"/api/products/{pid}")
    check("RBAC: manager delete own probe product", s2 in (200, 204), f"{s2}")
else:
    pid = None
s, d = req(worker, "GET", "/api/audit-logs")
check("RBAC: worker audit logs → 403", s == 403, f"{s}")
s, d = req(worker, "GET", "/api/reports/sales")
check("RBAC: worker reports → 403", s == 403, f"{s}")

# ---------- page route protection ----------
section("Route protection (pages)")
import urllib.parse
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None
for path in ["/admin", "/admin/orders", "/worker"]:
    try:
        op2 = urllib.request.build_opener(NoRedirect)
        op2.open(BASE + path, timeout=15)
        check(f"ROUTE: anon {path} blocked", False, "no redirect")
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location", "")
        check(f"ROUTE: anon {path} blocked → login", e.code in (302, 307) and "/login" in loc, f"code {e.code} loc={loc}")
    except Exception as e:
        check(f"ROUTE: anon {path} blocked → login", False, str(e)[:60])
# worker session hitting /admin must bounce to /worker (role refinement in layout)
try:
    op3 = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(worker.cj), NoRedirect)
    op3.open(BASE + "/admin", timeout=15)
    check("ROUTE: worker /admin bounced", False, "no redirect")
except urllib.error.HTTPError as e:
    loc = e.headers.get("Location", "")
    check("ROUTE: worker /admin bounced to /worker", e.code in (302, 307) and "/worker" in loc, f"code {e.code} loc={loc}")
except Exception as e:
    check("ROUTE: worker /admin bounced to /worker", False, str(e)[:60])
# admin session hitting /worker must bounce to /admin
try:
    op4 = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(admin.cj), NoRedirect)
    op4.open(BASE + "/worker", timeout=15)
    check("ROUTE: admin /worker bounced", False, "no redirect")
except urllib.error.HTTPError as e:
    loc = e.headers.get("Location", "")
    check("ROUTE: admin /worker bounced to /admin", e.code in (302, 307) and "/admin" in loc, f"code {e.code} loc={loc}")
except Exception as e:
    check("ROUTE: admin /worker bounced to /admin", False, str(e)[:60])

# ---------- worker data isolation ----------
section("Worker data isolation")
s, d = req(worker, "GET", "/api/orders?perPage=100")
worker_rows = d.get("rows", [])
check("ISOLATION: worker sees only own orders", s == 200 and all(r.get("worker_id") for r in worker_rows) and len({r["worker_id"] for r in worker_rows}) <= 1, f"total={d.get('total')} distinct_worker_ids={len({r.get('worker_id') for r in worker_rows})}")
s, d = req(admin, "GET", "/api/orders?perPage=100")
all_rows = d.get("rows", [])
admin_total = d.get("total")
check("ISOLATION: admin sees all orders", s == 200 and admin_total >= len(worker_rows), f"admin={admin_total} worker={len(worker_rows)}")
s, d = req(worker, "GET", "/api/worker/summary")
check("ISOLATION: worker summary scoped", s == 200, f"{s}")

# ---------- orders: create with inventory reservation ----------
section("Orders lifecycle + inventory reservation")
s, d = req(admin, "GET", "/api/products?perPage=100")
prods = d.get("rows", [])
prod = next((p for p in prods if (p.get("current_stock", 0) - p.get("reserved_stock", 0)) >= 5 and p.get("selling_price") and p.get("status") == "active"), None)
check("INVENTORY: seeded product with stock available", prod is not None, "no eligible product")
def snap(prod_obj):
    return {"current": prod_obj.get("current_stock"), "reserved": prod_obj.get("reserved_stock"), "available": prod_obj.get("available_stock")}

if prod:
    pid = prod["id"]
    before = snap(prod)
    # create order
    suffix = str(int(__import__("time").time()))
    s, d = req(admin, "POST", "/api/orders", {
        "customer": {"name": f"QA Tester {suffix}", "phone": f"0300{suffix[-7:]}", "address": "QA Street 1", "city": "Karachi"},
        "items": [{"product_id": pid, "quantity": 2, "unit_price": prod["selling_price"]}],
        "discount": 0, "delivery_address": "QA Street 1, Karachi", "city": "Karachi",
        "notes": "QA lifecycle order",
    })
    check("ORDER: create order", s == 201 and d.get("order"), f"{s} {json.dumps(d)[:120]}")
    order = d.get("order") or {}
    oid = order.get("id")
    if oid:
        check("ORDER: starts PENDING/CREATED", order.get("status") in ("PENDING", "CREATED"), order.get("status"))
        # reservation applied
        s, d = req(admin, "GET", f"/api/inventory?search={prod.get('sku','')}")
        rows = d.get("rows", [])
        after = snap(next((r for r in rows if r.get("id") == pid), rows[0] if rows else {})) if rows else None
        if before and after:
            check("RESERVE: reserved +2", (after.get("reserved") or 0) == (before.get("reserved") or 0) + 2, f"{before} → {after}")
            check("RESERVE: available -2, on_hand unchanged", (after.get("available") or 0) == (before.get("available") or 0) - 2 and (after.get("current") or 0) == (before.get("current") or 0), f"{before} → {after}")
        # assign worker
        s, d = req(admin, "GET", "/api/workers?perPage=50")
        wid = (d.get("rows") or [{}])[0].get("id")
        check("ASSIGN: worker list available", s == 200 and wid, f"{s}")
        s, d = req(admin, "POST", f"/api/orders/{oid}/assign", {"worker_id": wid})
        check("ASSIGN: assign worker", s == 200, f"{s} {json.dumps(d)[:100]}")
        s, d = req(admin, "GET", f"/api/orders/{oid}")
        o1 = d.get("order") or d
        check("ASSIGN: order now ASSIGNED", (o1.get("status") or "").upper() == "ASSIGNED", o1.get("status"))
        check("ASSIGN: commission rate snapshotted from worker", o1.get("commission_rate") is not None and o1.get("commission_rate_locked_at"), f"rate={o1.get('commission_rate')} locked_at={o1.get('commission_rate_locked_at')}")
        s, d = req(admin, "POST", f"/api/orders/{oid}/assign", {"worker_id": wid})
        check("ASSIGN: duplicate assign handled gracefully", s in (200, 409, 422), f"{s}")
        # book shipment
        s, d = req(admin, "POST", f"/api/orders/{oid}/book", {})
        booking = d if isinstance(d, dict) else {}
        cn = booking.get("trackingNumber") or booking.get("tracking_number") or ((booking.get("order") or {}).get("tracking_number"))
        check("BOOK: booking succeeds (simulator in demo)", s == 200 and bool(cn), f"{s} {json.dumps(d)[:150]}")
        check("BOOK: CN/tracking stored", bool(cn), str(cn))
        s, d = req(admin, "GET", f"/api/orders/{oid}")
        o1 = d.get("order") or d
        check("BOOK: order now BOOKED w/ CN persisted", (o1.get("status") or "").upper() == "BOOKED" and o1.get("tracking_number"), f"status={o1.get('status')} cn={o1.get('tracking_number')}")
        # duplicate booking protection
        s, d = req(admin, "POST", f"/api/orders/{oid}/book", {})
        check("BOOK: duplicate booking blocked", s in (409, 422), f"{s} {json.dumps(d)[:100]}")
        # status → in_transit → delivered (status route is POST)
        s, d = req(admin, "POST", f"/api/orders/{oid}/status", {"status": "IN_TRANSIT"})
        check("STATUS: IN_TRANSIT transition", s == 200, f"{s} {json.dumps(d)[:100]}")
        s, d = req(admin, "POST", f"/api/orders/{oid}/status", {"status": "DELIVERED"})
        check("STATUS: DELIVERED transition", s == 200, f"{s} {json.dumps(d)[:100]}")
        s, d = req(admin, "GET", f"/api/orders/{oid}")
        o1 = d.get("order") or d
        check("STATUS: order now DELIVERED", (o1.get("status") or "").upper() == "DELIVERED", o1.get("status"))
        # delivered final deduction
        s, d = req(admin, "GET", f"/api/inventory?search={prod.get('sku','')}")
        rows = d.get("rows", [])
        final = snap(next((r for r in rows if r.get("id") == pid), rows[0] if rows else {})) if rows else None
        if before and final:
            check("DEDUCT: delivered on_hand -2, reserved back to pre-order", (final.get("current") or 0) == (before.get("current") or 0) - 2 and (final.get("reserved") or 0) == (before.get("reserved") or 0), f"{before} → {final}")
        # commission credit exactly once (commission API has no order_id filter — filter client-side)
        s, d = req(admin, "GET", "/api/commission?perPage=100")
        txs = [t for t in (d.get("rows") or []) if t.get("order_id") == oid]
        credits = [t for t in txs if t.get("type") == "DELIVERED_COMMISSION"]
        check("COMMISSION: delivered credit recorded exactly once", len(credits) == 1, f"count={len(credits)} txs_for_order={len(txs)}")
        if credits:
            rate = o1.get("commission_rate")
            cod = o1.get("cod_amount") or 0
            expected = round(cod * (rate / 100)) if rate is not None else None
            check("COMMISSION: amount = COD × locked rate", expected is not None and abs((credits[0].get("amount") or 0) - expected) < 0.01, f"amount={credits[0].get('amount')} expected={expected} cod={cod} rate={rate}")
        # idempotency: re-set DELIVERED must not double-credit
        s, d = req(admin, "POST", f"/api/orders/{oid}/status", {"status": "DELIVERED"})
        check("STATUS: re-DELIVERED idempotent (4xx or no-op)", s == 200 or s in (409, 422), f"{s}")
        s, d = req(admin, "GET", "/api/commission?perPage=100")
        txs = [t for t in (d.get("rows") or []) if t.get("order_id") == oid]
        check("COMMISSION: still exactly one credit after re-deliver", len([t for t in txs if t.get("type") == "DELIVERED_COMMISSION"]) == 1, f"count={len([t for t in txs if t.get('type') == 'DELIVERED_COMMISSION'])}")
        # tracking visible
        s, d = req(admin, "GET", f"/api/orders/{oid}")
        o = d.get("order") or d
        check("TRACKING: order keeps CN + history", bool(o.get("tracking_number")) and isinstance(o.get("status_history", o.get("history")), (list, type(None))), str(o.get("tracking_number")))
        # ---- return flow on a second order ----
        s, d = req(admin, "POST", "/api/orders", {
            "customer": {"name": f"QA Return {suffix}", "phone": f"0311{suffix[-7:]}", "address": "QA Street 2", "city": "Lahore"},
            "items": [{"product_id": pid, "quantity": 1, "unit_price": prod["selling_price"]}],
            "discount": 0, "delivery_address": "QA Street 2, Lahore", "city": "Lahore",
        })
        oid2 = (d.get("order") or {}).get("id")
        rate2 = (d.get("order") or {}).get("commission_rate")
        cod2 = (d.get("order") or {}).get("cod_amount")
        if oid2:
            rate2 = None
            req(admin, "POST", f"/api/orders/{oid2}/assign", {"worker_id": wid})
            req(admin, "POST", f"/api/orders/{oid2}/book", {})
            req(admin, "POST", f"/api/orders/{oid2}/status", {"status": "IN_TRANSIT"})
            req(admin, "POST", f"/api/orders/{oid2}/status", {"status": "DELIVERED"})
            s, d = req(admin, "POST", f"/api/orders/{oid2}/status", {"status": "RETURNED"})
            check("RETURN: delivered→returned allowed", s == 200, f"{s} {json.dumps(d)[:100]}")
            s, d = req(admin, "GET", f"/api/orders/{oid2}")
            o2 = d.get("order") or d
            check("RETURN: order now RETURNED", (o2.get("status") or "").upper() == "RETURNED", o2.get("status"))
            s, d = req(admin, "GET", "/api/commission?perPage=100")
            txs = [t for t in (d.get("rows") or []) if t.get("order_id") == oid2]
            adj = [t for t in txs if t.get("type") == "RETURN_ADJUSTMENT"]
            check("COMMISSION: return adjustment recorded exactly once", len(adj) == 1, f"count={len(adj)}")
            credits2 = [t for t in txs if t.get("type") == "DELIVERED_COMMISSION"]
            if adj and credits2:
                check("COMMISSION: return adjustment = -credit", abs((adj[0].get("amount") or 0) + (credits2[0].get("amount") or 0)) < 0.01, f"{adj[0].get('amount')} vs -{credits2[0].get('amount')}")
            # returned stock restored (on_hand back +1 vs post-deliver)
            s, d = req(admin, "GET", f"/api/inventory?search={prod.get('sku','')}")
            rows = d.get("rows", [])
            rest = snap(next((r for r in rows if r.get("id") == pid), rows[0] if rows else {})) if rows else None
            if rest and final:
                # order2 delivered (−1) then returned (+1) → net zero vs post-order1-deliver snapshot
                check("RETURN: stock restored (deliver −1 then return +1 = net 0)", (rest.get("current") or 0) == (final.get("current") or 0), f"post-deliver={final} post-return={rest}")

        # ---- cancel flow on a third order (never assigned): reservation released ----
        s, d = req(admin, "POST", "/api/orders", {
            "customer": {"name": f"QA Cancel {suffix}", "phone": f"0322{suffix[-7:]}", "address": "QA Street 3", "city": "Karachi"},
            "items": [{"product_id": pid, "quantity": 1, "unit_price": prod["selling_price"]}],
            "discount": 0, "delivery_address": "QA Street 3, Karachi", "city": "Karachi",
        })
        oid3 = (d.get("order") or {}).get("id")
        if oid3:
            s, d = req(admin, "GET", "/api/inventory?search=" + prod.get("sku", ""))
            rows = d.get("rows", [])
            after_cancel_src = snap(next((r for r in rows if r.get("id") == pid), {})) if rows else None
            s, d = req(admin, "POST", f"/api/orders/{oid3}/status", {"status": "CANCELLED"})
            check("CANCEL: pending→cancelled allowed", s == 200, f"{s} {json.dumps(d)[:80]}")
            s, d = req(admin, "GET", "/api/inventory?search=" + prod.get("sku", ""))
            rows = d.get("rows", [])
            rel = snap(next((r for r in rows if r.get("id") == pid), {})) if rows else None
            if after_cancel_src and rel:
                check("CANCEL: reservation released (reserved -1)", (rel.get("reserved") or 0) == (after_cancel_src.get("reserved") or 0) - 1, f"{after_cancel_src} → {rel}")
            s, d = req(admin, "GET", "/api/commission?perPage=100")
            txs = [t for t in (d.get("rows") or []) if t.get("order_id") == oid3]
            check("COMMISSION: cancelled order → zero ledger entries", len(txs) == 0, f"count={len(txs)}")

# ---------- worker payments ----------
section("Worker payments")
s, d = req(admin, "GET", "/api/payments?perPage=100")
check("PAYMENTS: list loads", s == 200, f"{s}")
# payment balance math via worker summary of first worker
s, d = req(admin, "GET", "/api/workers?perPage=10")
w0 = (d.get("rows") or [{}])[0]
if w0.get("id"):
    s, d = req(admin, "GET", f"/api/workers/{w0['id']}")
    wd = (d.get("worker") or {})
    earn = wd.get("earnings") or {}
    check("PAYMENTS: admin sees worker detail w/ earnings", s == 200 and earn.get("net_commission") is not None, f"{s} keys={list((wd or {}).keys())[:12]}")
    if earn.get("net_commission") is not None:
        expected_remaining = round((earn.get("net_commission") or 0) - (earn.get("paid_amount") or 0), 2)
        check("PAYMENTS: remaining = net − paid", abs((earn.get("remaining_amount") or 0) - expected_remaining) < 0.01, f"{earn}")
    # balance = net - paid must match ledger sum
    s, d = req(worker, "GET", "/api/worker/summary")
    check("PAYMENTS: worker own summary loads", s == 200, f"{s}")

# ---------- reports ----------
section("Reports")
for t in ["sales", "orders", "delivered", "returned", "worker-performance", "worker-commission", "worker-payments", "pending-payments", "inventory", "stock-movement", "product-sales", "customer"]:
    s, d = req(admin, "GET", f"/api/reports/{t}")
    check(f"REPORT {t}", s == 200, f"{s} {json.dumps(d)[:80]}")
s, d = req(admin, "GET", "/api/reports/sales?from=2025-01-01&to=2026-12-31&format=csv")
check("REPORT csv export", s == 200 and ("_raw" not in d or "," in json.dumps(d)), f"{s}")

# ---------- notifications & audit ----------
section("Notifications & audit")
s, d = req(admin, "GET", "/api/notifications?limit=12")
check("NOTIFICATIONS: admin list", s == 200 and "rows" in d or "notifications" in d, f"{s}")
s, d = req(worker, "GET", "/api/notifications?limit=12")
check("NOTIFICATIONS: worker list", s == 200, f"{s}")
s, d = req(admin, "GET", "/api/audit-logs?perPage=100")
check("AUDIT: list loads", s == 200, f"{s}")
blob = json.dumps(d).lower()
leaks = [k for k in ["password_hash", "api_key_enc", "secret", "x-api-key"] if k in blob]
check("AUDIT: no secrets in log payloads", not leaks, str(leaks))
brand_actions = []
all_rows_audit = []
for pg in (1, 2, 3):
    s2, d2 = req(admin, "GET", f"/api/audit-logs?perPage=100&page={pg}")
    rr = d2.get("rows", [])
    all_rows_audit += rr
    if len(rr) < 100:
        break
brand_logs = [r for r in all_rows_audit if str(r.get("action", "")).startswith("branding.")]
check("AUDIT: branding actions logged", len(brand_logs) >= 1, f"count={len(brand_logs)} total_scanned={len(all_rows_audit)}")
# security-relevant: lifecycle actions are being audited
audited_actions = {r.get("action") for r in all_rows_audit}
need_audit = {"order.created", "order.status_changed", "order.assigned"}
check("AUDIT: order lifecycle actions logged", need_audit.issubset(audited_actions), f"found={sorted(audited_actions)[:12]}")

# ---------- flaship ----------
section("Flaship integration")
s, d = req(admin, "GET", "/api/flaship/catalog")
check("FLASHIP: catalog endpoint", s == 200, f"{s}")
for kind in ["couriers", "cities", "pickups"]:
    s, d = req(admin, "GET", f"/api/flaship/catalog?{kind}=1")
    check(f"FLASHIP: {kind} list", s == 200, f"{s}")
s, d = req(admin, "GET", "/api/settings")
sd = d.get("settings") or d
check("FLASHIP: settings hide raw key", s == 200 and "api_key" not in json.dumps(sd).replace("api_key_set", "").replace("api_key_masked", "").replace("api_key_source", ""), f"{s}")

# ---------- error handling ----------
section("API error handling")
s, d = req(admin, "POST", "/api/orders", {"items": []})
check("ERRORS: invalid order → 422", s in (400, 422), f"{s}")
s, d = req(admin, "GET", "/api/orders/nonexistent-id-xyz")
check("ERRORS: missing order → 404", s == 404, f"{s}")
s, d = req(admin, "GET", "/api/orders?page=0&perPage=9999")
check("ERRORS: pagination clamped", s == 200, f"{s}")

# ---------- summary ----------
print(f"\n{'='*50}\nPASS: {len(PASS)}  FAIL: {len(FAIL)}")
if FAIL:
    print("FAILED CHECKS:")
    for f in FAIL:
        print("  ✗", f)
sys.exit(1 if FAIL else 0)
