#!/usr/bin/env bash
# ============================================================================
# RoyalCarePK E2E verification — Worker Order Approval Workflow + Worker Delete
# Production build (demo store + Flaship simulator). Two phases:
#   PHASE=1  tests 1–11a: worker create → admin approve/reject → booking →
#            REAL Flaship failure (unreachable base URL + dummy key)
#   PHASE=2  tests 11b–15: retry after fix (successful), worker delete,
#            permission guards, audit trail, existing-feature sanity
# State is passed between phases via /tmp/rc_state.env
# ============================================================================
set -u
BASE="${BASE:-http://localhost:3001}"
PHASE="${PHASE:-1}"
STATE=/tmp/rc_state.env
JAR_ADMIN=/tmp/rc_admin.jar JAR_WORKER=/tmp/rc_worker.jar JAR_TMP=/tmp/rc_tmp.jar JAR_MGR=/tmp/rc_mgr.jar
rm -f "$JAR_ADMIN" "$JAR_WORKER" "$JAR_TMP" "$JAR_MGR"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected [$2] got [$1])"; fi; }

api() { # method path jar [json]
  local m=$1 p=$2 j=$3 d=${4:-}
  if [ -n "$d" ]; then
    curl -s -w "\n%{http_code}" -X "$m" -b "$j" -c "$j" -H "Content-Type: application/json" -d "$d" "$BASE$p"
  else
    curl -s -w "\n%{http_code}" -X "$m" -b "$j" -c "$j" "$BASE$p"
  fi
}
body(){ sed '$d'; }
code(){ tail -n1; }

login_all() {
  R=$(api POST /api/auth/login "$JAR_WORKER" '{"email":"ali@demo.com","password":"worker123"}')
  check "$(echo "$R" | code)" "200" "worker login 200"
  R=$(api POST /api/auth/login "$JAR_ADMIN" '{"email":"admin@demo.com","password":"admin123"}')
  check "$(echo "$R" | code)" "200" "admin (super admin) login"
  R=$(api POST /api/auth/login "$JAR_MGR" '{"email":"manager@demo.com","password":"admin123"}')
  check "$(echo "$R" | code)" "200" "manager login"
  CUSTOMER=$(api GET /api/lookup "$JAR_WORKER" | body | jq -r '.customers[0].id')
  PRODUCT=$(api GET /api/lookup "$JAR_WORKER" | body | jq -r '.products[0].id')
  [ "$CUSTOMER" != "null" ] && [ "$PRODUCT" != "null" ] && ok "lookup (customers+products) ok" || bad "lookup failed"
}

mk_order() { # jar addr city qty
  api POST /api/orders "$1" "{\"customer\":{\"id\":\"$CUSTOMER\"},\"items\":[{\"product_id\":\"$PRODUCT\",\"quantity\":${4:-1},\"unit_price\":0}],\"discount\":0,\"delivery_address\":\"$2\",\"city\":\"$3\"}"
}

if [ "$PHASE" = "1" ]; then
  echo "════ PHASE 1 ═══="
  echo "── TEST 1: Worker logs in ──"
  login_all

  echo "── TEST 2/3: Worker creates order → PENDING, Flaship NOT called ──"
  R=$(mk_order "$JAR_WORKER" "Test Street 1" "Karachi" 2)
  O1=$(echo "$R" | body | jq -r .order.id)
  check "$(echo "$R" | code)" "201" "order created (201)"
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "PENDING" "approval_status = PENDING"
  check "$(echo "$R" | body | jq -r '.order.booking_status')" "not_booked" "booking_status = not_booked (Flaship NOT called)"
  check "$(echo "$R" | body | jq -r '.order.tracking_number')" "null" "no tracking number"
  check "$(echo "$R" | body | jq -r '.order.status')" "PENDING" "order status = PENDING"
  TOTAL=$(echo "$R" | body | jq -r '.order.total')
  [ "$TOTAL" != "0" ] && [ "$TOTAL" != "null" ] && [ -n "$TOTAL" ] && ok "order priced from catalogue (total=$TOTAL) — client price ignored" || bad "worker order total is $TOTAL (price trust bug)"
  SUB=$(echo "$R" | body | jq -r '.order.submitted_at')
  [ "$SUB" != "null" ] && [ -n "$SUB" ] && ok "submitted_at recorded" || bad "submitted_at missing"

  echo "── TEST 4: Admin sees order under Pending Approvals ──"
  R=$(api GET "/api/orders?approval=PENDING&include_items=1&perPage=10" "$JAR_ADMIN")
  FOUND=$(echo "$R" | body | jq --arg id "$O1" '[.rows[] | select(.id==$id)] | length')
  check "$FOUND" "1" "pending order listed with approval filter"
  ITEMS=$(echo "$R" | body | jq --arg id "$O1" '.rows[] | select(.id==$id) | .items | length')
  [ "$ITEMS" -ge 1 ] 2>/dev/null && ok "items summary attached" || bad "items missing"
  WN=$(echo "$R" | body | jq -r --arg id "$O1" '.rows[] | select(.id==$id) | .worker_name')
  [ -n "$WN" ] && [ "$WN" != "null" ] && ok "worker name shown ($WN)" || bad "worker name missing"

  echo "── TEST 5: Reject WITHOUT reason → blocked ──"
  R=$(api POST "/api/orders/$O1/reject" "$JAR_ADMIN" '{}')
  check "$(echo "$R" | code)" "422" "rejection without reason → 422"
  R=$(api POST "/api/orders/$O1/reject" "$JAR_ADMIN" '{"reason":"   "}')
  check "$(echo "$R" | code)" "422" "whitespace-only reason → 422"

  echo "── TEST 6: Reject WITH reason → worker sees REJECTED + reason ──"
  R=$(api POST "/api/orders/$O1/reject" "$JAR_ADMIN" '{"reason":"Customer address is incomplete."}')
  check "$(echo "$R" | code)" "200" "rejection accepted"
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "REJECTED" "approval_status = REJECTED"
  check "$(echo "$R" | body | jq -r '.order.rejection_reason')" "Customer address is incomplete." "reason saved"
  check "$(echo "$R" | body | jq -r '.order.status')" "CANCELLED" "order cancelled (stock reservation released)"
  R=$(api GET "/api/orders/$O1" "$JAR_WORKER")
  check "$(echo "$R" | body | jq -r '.order.rejection_reason')" "Customer address is incomplete." "worker sees rejection reason"
  RN=$(api GET "/api/notifications" "$JAR_WORKER" | body | jq '[.rows[]? | select(.title=="Order rejected")] | length' 2>/dev/null)
  [ "${RN:-0}" -ge 1 ] 2>/dev/null && ok "worker received rejection notification" || bad "worker rejection notification missing"

  echo "── TEST 7/8: Worker order 2 → admin approves → Flaship booking ──"
  R=$(mk_order "$JAR_WORKER" "Test Street 2" "Lahore" 1)
  O2=$(echo "$R" | body | jq -r .order.id)
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "PENDING" "order 2 PENDING"
  R=$(api POST "/api/orders/$O2/approve" "$JAR_ADMIN" '{}')
  check "$(echo "$R" | code)" "200" "approve → 200"
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "APPROVED" "approval_status = APPROVED"
  check "$(echo "$R" | body | jq -r '.bookingAttempted')" "true" "booking attempted"
  CN=$(echo "$R" | body | jq -r '.booking.trackingNumber // empty')
  [ -n "$CN" ] && ok "TEST 9: Flaship booking succeeded, CN=$CN" || bad "TEST 9: no CN returned"
  check "$(echo "$R" | body | jq -r '.order.status')" "BOOKED" "order status = BOOKED (fresh read)"
  check "$(echo "$R" | body | jq -r '.order.booking_status')" "booked" "booking_status = booked (fresh read)"
  R=$(api GET "/api/orders/$O2" "$JAR_ADMIN")
  check "$(echo "$R" | body | jq -r '.order.tracking_number')" "$CN" "CN persisted on order"
  SH=$(echo "$R" | body | jq -r '.shipment.tracking_number // empty')
  check "$SH" "$CN" "shipment row saved with CN"
  WN=$(api GET /api/notifications "$JAR_WORKER" | body | jq '[.rows[]? | select(.title=="Order approved")] | length' 2>/dev/null)
  [ "${WN:-0}" -ge 1 ] 2>/dev/null && ok "worker received approval notification" || bad "worker approval notification missing"

  echo "── TEST 10: Approve again → NO duplicate booking ──"
  R=$(api POST "/api/orders/$O2/approve" "$JAR_ADMIN" '{}')
  check "$(echo "$R" | body | jq -r '.alreadyBooked')" "true" "idempotent approve (alreadyBooked)"
  CN2=$(echo "$R" | body | jq -r '.booking.trackingNumber // empty')
  check "$CN2" "$CN" "same CN returned — no duplicate shipment"
  RC=$(api POST "/api/orders/$O2/book" "$JAR_ADMIN" '{}' | code)
  check "$RC" "422" "direct re-book blocked (duplicate prevention)"

  echo "── TEST 11a: REAL Flaship failure → stays APPROVED, error shown ──"
  # break connectivity: unreachable base URL + dummy key (activates live mode)
  R=$(api PATCH /api/settings "$JAR_ADMIN" '{"key":"flaship","value":{"base_url":"http://127.0.0.1:9/api/integration","api_key":"bogus-key-for-failure-test"}}')
  check "$(echo "$R" | code)" "200" "flaship pointed at unreachable host (live mode)"
  R=$(mk_order "$JAR_WORKER" "Test Street 3" "Karachi" 1)
  O3=$(echo "$R" | body | jq -r .order.id)
  R=$(api POST "/api/orders/$O3/approve" "$JAR_ADMIN" '{}')
  check "$(echo "$R" | code)" "200" "approve endpoint still 200 on booking failure"
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "APPROVED" "TEST 11: approval REMAINS APPROVED"
  BERR=$(echo "$R" | body | jq -r '.bookingError // empty')
  [ -n "$BERR" ] && ok "booking failure surfaced to admin: ${BERR:0:50}…" || bad "no bookingError in response"
  check "$(echo "$R" | body | jq -r '.booking')" "null" "no booking object on failure"
  R=$(api GET "/api/orders/$O3" "$JAR_ADMIN")
  check "$(echo "$R" | body | jq -r '.order.booking_status')" "failed" "booking_status = failed"
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "APPROVED" "approval still APPROVED (re-read)"
  BE=$(echo "$R" | body | jq -r '.order.booking_error // empty')
  [ -n "$BE" ] && ok "booking_error persisted on order" || bad "booking_error missing on order"

  # save state for phase 2
  cat > "$STATE" <<EOF
O1=$O1
O2=$O2
O3=$O3
CN=$CN
EOF
  echo "── PHASE 1 RESULT: $PASS passed, $FAIL failed ──"
else
  echo "════ PHASE 2 ════"
  login_all
  source "$STATE"

  echo "── TEST 11b: Retry after fix → succeeds, no duplicate ──"
  R=$(api POST "/api/orders/$O3/book" "$JAR_ADMIN" '{}')
  check "$(echo "$R" | code)" "200" "TEST 11: admin retry booking → 200"
  CN3=$(echo "$R" | body | jq -r '.trackingNumber // .booking.trackingNumber // empty')
  [ -n "$CN3" ] && ok "TEST 11: retry produced CN=$CN3" || bad "retry produced no CN"
  R=$(api GET "/api/orders/$O3" "$JAR_ADMIN")
  check "$(echo "$R" | body | jq -r '.order.booking_status')" "booked" "retry: booking_status = booked"
  check "$(echo "$R" | body | jq -r '.order.tracking_number')" "$CN3" "CN persisted after retry"
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "APPROVED" "approval unchanged through retry"
  # retry again → blocked as duplicate
  RC=$(api POST "/api/orders/$O3/book" "$JAR_ADMIN" '{}' | code)
  check "$RC" "422" "second retry blocked (no duplicate shipment)"

  echo "── TEST 12: Delete worker account → login fails, history intact ──"
  R=$(api POST /api/workers "$JAR_ADMIN" '{"name":"Temp Worker","email":"temp.e2e@demo.com","phone":"03001112233","password":"temp123","commission_rate":5}')
  WID=$(echo "$R" | body | jq -r .id)
  check "$(echo "$R" | code)" "201" "temp worker created"
  RC=$(api DELETE "/api/workers/$WID" "$JAR_MGR" | code)
  check "$RC" "403" "admin (non-super) delete blocked 403"
  R=$(api POST /api/auth/login "$JAR_TMP" '{"email":"temp.e2e@demo.com","password":"temp123"}')
  check "$(echo "$R" | code)" "200" "temp worker login"
  R=$(mk_order "$JAR_TMP" "Temp Addr" "Karachi" 1)
  OW=$(echo "$R" | body | jq -r .order.id)
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "PENDING" "temp worker pending order created"
  R=$(api DELETE "/api/workers/$WID" "$JAR_ADMIN")
  check "$(echo "$R" | code)" "200" "super admin delete worker → 200"
  check "$(echo "$R" | body | jq -r '.deleted.orders_auto_rejected')" "1" "pending order auto-rejected on delete"
  R=$(api POST /api/auth/login "$JAR_TMP" '{"email":"temp.e2e@demo.com","password":"temp123"}')
  check "$(echo "$R" | code)" "401" "TEST 12: deleted worker CANNOT log in (401)"
  R=$(api GET "/api/orders/$OW" "$JAR_ADMIN")
  check "$(echo "$R" | code)" "200" "historical order still exists"
  check "$(echo "$R" | body | jq -r '.order.worker_name_snapshot')" "Temp Worker" "worker name snapshot preserved"
  check "$(echo "$R" | body | jq -r '.order.worker_email_snapshot')" "temp.e2e@demo.com" "worker email snapshot preserved"
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "REJECTED" "auto-rejected on deletion"
  check "$(echo "$R" | body | jq -r '.order.rejection_reason')" "Worker account was deleted — order automatically rejected." "auto-rejection reason"
  # commission + payments history of the deleted worker preserved (empty for temp but tables work)
  RC=$(api GET /api/commission "$JAR_ADMIN" | code)
  check "$RC" "200" "commission ledger endpoint intact"
  RC=$(api GET /api/payments "$JAR_ADMIN" | code)
  check "$RC" "200" "payments endpoint intact"

  echo "── TEST 13: Worker cannot approve/reject ──"
  R=$(mk_order "$JAR_WORKER" "Test Street 4" "Karachi" 1)
  O4=$(echo "$R" | body | jq -r .order.id)
  RC=$(api POST "/api/orders/$O4/approve" "$JAR_WORKER" '{}' | code)
  check "$RC" "403" "worker approve → 403"
  RC=$(api POST "/api/orders/$O4/reject" "$JAR_WORKER" '{"reason":"self"}' | code)
  check "$RC" "403" "worker reject → 403"

  echo "── TEST 14: Worker cannot manipulate approval/status/booking ──"
  RC=$(api PATCH "/api/orders/$O4" "$JAR_WORKER" '{"approval_status":"APPROVED","cod_amount":1}' | code)
  check "$RC" "403" "worker PATCH order → 403 (approval fields unreachable)"
  RC=$(api POST "/api/orders/$O4/book" "$JAR_WORKER" '{}' | code)
  check "$RC" "403" "worker book with Flaship → 403"
  RC=$(api POST "/api/orders/$O4/status" "$JAR_WORKER" '{"status":"DELIVERED"}' | code)
  check "$RC" "422" "worker status jump PENDING→DELIVERED → 422"
  RC=$(api POST "/api/orders/$O4/status" "$JAR_WORKER" '{"status":"CANCELLED"}' | code)
  check "$RC" "422" "worker cannot cancel own pending order → 422"
  # service-level approval gate: even an ADMIN cannot book a PENDING order
  R=$(api POST "/api/orders/$O4/book" "$JAR_ADMIN" '{}')
  RC=$(echo "$R" | code)
  check "$RC" "422" "admin booking PENDING order → blocked 422 (service-level gate)"
  MSG=$(echo "$R" | body | jq -r '.error // empty')
  case "$MSG" in *"not been approved"*) ok "gate message: ${MSG:0:50}…";; *) bad "unexpected gate error: $MSG";; esac

  echo "── TEST 15: Worker isolation ──"
  OTHER_ORDER=$(api GET /api/orders "$JAR_ADMIN" | body | jq -r '[.rows[] | select(.worker_id==null)][0].id // empty')
  if [ -n "$OTHER_ORDER" ] && [ "$OTHER_ORDER" != "$O4" ]; then
    RC=$(api GET "/api/orders/$OTHER_ORDER" "$JAR_WORKER" | code)
    check "$RC" "403" "worker cannot read unassigned/admin order"
  else
    ok "no unassigned order available for isolation probe (skipped)"
  fi
  RC=$(api GET /api/workers "$JAR_WORKER" | code)
  check "$RC" "403" "worker cannot list workers"
  RC=$(api GET /api/audit-logs "$JAR_WORKER" | code)
  check "$RC" "403" "worker cannot read audit logs"
  RC=$(api GET /api/settings "$JAR_WORKER" | code)
  check "$RC" "403" "worker cannot read settings (Flaship config)"
  WK=$(api GET /api/lookup "$JAR_WORKER" | body | jq 'has("flaship") or has("workers")')
  check "$WK" "false" "worker lookup exposes no flaship/workers keys"

  echo "── Audit trail ──"
  R=$(api GET "/api/audit-logs?perPage=100" "$JAR_ADMIN")
  for a in order.submitted order.approved order.rejected flaship.booking_created flaship.booking_failed flaship.booking_blocked worker.deleted order.created; do
    CNT=$(echo "$R" | body | jq --arg a "$a" '[.rows[]? | select(.action==$a)] | length' 2>/dev/null)
    if [ "${CNT:-0}" -ge 1 ] 2>/dev/null; then ok "audit contains $a ($CNT)"; else bad "audit missing $a"; fi
  done

  echo "── Existing features sanity (unchanged flows) ──"
  for ep in /api/products /api/customers /api/categories /api/orders /api/dashboard /api/notifications /api/reports/sales /api/worker/summary; do
    J=$JAR_ADMIN; [ "$ep" = "/api/worker/summary" ] && J=$JAR_WORKER
    RC=$(api GET "$ep" "$J" | code)
    check "$RC" "200" "GET $ep still 200"
  done
  R=$(api POST /api/orders "$JAR_ADMIN" "{\"customer\":{\"id\":\"$CUSTOMER\"},\"items\":[{\"product_id\":\"$PRODUCT\",\"quantity\":1,\"unit_price\":0}],\"discount\":0,\"delivery_address\":\"Admin Addr\",\"city\":\"Karachi\"}")
  check "$(echo "$R" | code)" "201" "admin order creation still works"
  check "$(echo "$R" | body | jq -r '.order.approval_status')" "APPROVED" "admin-created order stays auto-APPROVED"
  R=$(api GET "/api/worker/summary" "$JAR_WORKER")
  check "$(echo "$R" | code)" "200" "worker summary still works"
  echo "── PHASE 2 RESULT: $PASS passed, $FAIL failed ──"
fi

echo "── TOTAL: $PASS passed, $FAIL failed ──"
[ "$FAIL" = "0" ]
