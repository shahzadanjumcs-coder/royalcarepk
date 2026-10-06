-- ============================================================================
-- RoyalCarePK — cancelled TEST order cleanup (CN 173018508325)
-- + test-product identification
--
-- Run in: Supabase Dashboard → SQL editor.
-- Safety model:
--   * Verification SELECTs first — review the output BEFORE running step 2+.
--   * The DO block is a single transaction: any guard failure aborts EVERYTHING.
--   * Preferred path: the admin UI (Orders → cancelled test order → Danger
--     zone → Delete cancelled order) performs the same cleanup, writes an
--     order.deleted audit entry and requires super_admin. Use this script
--     only if you prefer doing it in SQL.
--   * flaship_logs and audit_logs are PRESERVED (append-only observability).
--   * Flaship is NOT contacted — the test booking was already cancelled there.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 0 — identify the exact test order (no writes)
-- ---------------------------------------------------------------------------
SELECT id, order_number, status, booking_status, tracking_number, customer_id,
       worker_id, total, created_at, booked_at
FROM orders
WHERE tracking_number = '173018508325';

-- ---------------------------------------------------------------------------
-- STEP 1 — show everything that belongs to it (no writes)
-- Replace :OID with the id printed above (or run the variants below).
-- ---------------------------------------------------------------------------
WITH t AS (SELECT id FROM orders WHERE tracking_number = '173018508325')
SELECT 'order_items' AS relation, count(*) FROM order_items      WHERE order_id = (SELECT id FROM t)
UNION ALL SELECT 'order_status_history', count(*) FROM order_status_history WHERE order_id = (SELECT id FROM t)
UNION ALL SELECT 'shipments',            count(*) FROM shipments            WHERE order_id = (SELECT id FROM t)
UNION ALL SELECT 'shipment_tracking',    count(*) FROM shipment_tracking    WHERE order_id = (SELECT id FROM t)
UNION ALL SELECT 'commission_transactions', count(*) FROM commission_transactions WHERE order_id = (SELECT id FROM t)
UNION ALL SELECT 'whatsapp_message_queue',  count(*) FROM whatsapp_message_queue  WHERE order_id = (SELECT id FROM t)
UNION ALL SELECT 'inventory_movements (loose ref)', count(*) FROM inventory_movements WHERE order_id = (SELECT id FROM t)
UNION ALL SELECT 'flaship_logs (preserved)', count(*) FROM flaship_logs WHERE order_id = (SELECT id FROM t);

-- notifications pointing at the order (admin bell feed)
SELECT n.id, n.title, n.link, n.created_at
FROM notifications n
WHERE n.link IN (
  SELECT '/admin/orders/' || id FROM orders WHERE tracking_number = '173018508325'
  UNION
  SELECT '/worker/orders/' || id FROM orders WHERE tracking_number = '173018508325'
);

-- which products did this test order use? (candidates for PART 3 cleanup once
-- the order is gone and no other order references them)
SELECT DISTINCT p.id, p.name, p.sku, p.status, p.created_at,
       (SELECT count(*) FROM order_items oi WHERE oi.product_id = p.id) AS total_order_references
FROM products p
JOIN order_items oi ON oi.product_id = p.id
JOIN orders o ON o.id = oi.order_id
WHERE o.tracking_number = '173018508325';

-- ---------------------------------------------------------------------------
-- STEP 1b — test/demo product candidates (no writes; evidence only)
-- A product is a confident test-data candidate ONLY when ALL hold:
--   * zero references from ANY order_item (never used by a real order)
--   * name or SKU clearly marked test/demo/sample
-- Review the output, then delete through the Admin Products UI (safe hard
-- delete is allowed for unreferenced products) or uncomment STEP 3b.
-- ---------------------------------------------------------------------------
SELECT p.id, p.name, p.sku, p.status, p.created_at,
       (SELECT count(*) FROM order_items oi WHERE oi.product_id = p.id) AS order_references,
       (SELECT count(*) FROM inventory_movements im WHERE im.product_id = p.id) AS stock_movements
FROM products p
WHERE (p.name ILIKE '%test%' OR p.sku ILIKE '%test%'
    OR p.name ILIKE '%demo%' OR p.sku ILIKE '%demo%'
    OR p.name ILIKE '%sample%' OR p.sku ILIKE '%sample%')
ORDER BY p.created_at;

-- ---------------------------------------------------------------------------
-- STEP 2+3 — the cleanup transaction (SINGLE transaction; guards included)
-- Guards: order must exist, must be CANCELLED, must have NO commission rows.
-- ============================================================================
DO $$
DECLARE
  v_order        public.orders%ROWTYPE;
  v_items        int; v_ships int; v_tracking int; v_history int;
  v_queue        int; v_notifs int; v_movements int; v_commission int;
BEGIN
  SELECT * INTO v_order FROM orders WHERE tracking_number = '173018508325';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ABORT: no order with tracking_number 173018508325 (already cleaned up?)';
  END IF;
  IF v_order.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'ABORT: order % is %, not CANCELLED — refusing to delete', v_order.order_number, v_order.status;
  END IF;

  SELECT count(*) INTO v_commission FROM commission_transactions WHERE order_id = v_order.id;
  IF v_commission > 0 THEN
    RAISE EXCEPTION 'ABORT: order % has % commission row(s) — review the ledger manually', v_order.order_number, v_commission;
  END IF;

  -- counts for the report (items/shipments/tracking/history are CASCADEd)
  SELECT count(*) INTO v_items      FROM order_items           WHERE order_id = v_order.id;
  SELECT count(*) INTO v_ships      FROM shipments             WHERE order_id = v_order.id;
  SELECT count(*) INTO v_tracking   FROM shipment_tracking     WHERE order_id = v_order.id;
  SELECT count(*) INTO v_history    FROM order_status_history  WHERE order_id = v_order.id;
  SELECT count(*) INTO v_queue      FROM whatsapp_message_queue WHERE order_id = v_order.id;

  -- notifications linked to this order's detail pages (admin + worker feeds)
  DELETE FROM notifications
   WHERE link IN ('/admin/orders/' || v_order.id, '/worker/orders/' || v_order.id);
  GET DIAGNOSTICS v_notifs = ROW_COUNT;

  -- WhatsApp queue rows for this order (FK would only SET NULL — remove the
  -- test remnants explicitly; they belong to the cancelled test booking)
  DELETE FROM whatsapp_message_queue WHERE order_id = v_order.id;

  -- inventory_movements.order_id is a loose column (no FK) — detach it so no
  -- dangling reference remains; the movement ledger itself is preserved.
  UPDATE inventory_movements SET order_id = NULL WHERE order_id = v_order.id;
  GET DIAGNOSTICS v_movements = ROW_COUNT;

  -- the order row: CASCADEs order_items, order_status_history, shipments,
  -- shipment_tracking; commission_transactions/flaship_logs are SET NULL.
  DELETE FROM orders WHERE id = v_order.id;

  RAISE NOTICE 'DELETED order % (CN 173018508325): order_items=%, shipments=%, tracking=%, history=%, whatsapp_queue=%, notifications=%, inventory_movements detached=%',
    v_order.order_number, v_items, v_ships, v_tracking, v_history, v_queue, v_notifs, v_movements;
  RAISE NOTICE 'PRESERVED: flaship_logs (order_id now NULL), audit_logs (immutable), commission ledger (none existed)';
END $$;

-- ---------------------------------------------------------------------------
-- STEP 4 — post-cleanup verification (all must hold)
-- ---------------------------------------------------------------------------
-- 4a. the CN is gone entirely
SELECT count(*) AS orders_left  FROM orders           WHERE tracking_number = '173018508325';  -- expect 0
SELECT count(*) AS items_left   FROM order_items      WHERE order_id NOT IN (SELECT id FROM orders);  -- expect 0
SELECT count(*) AS ship_left    FROM shipments        WHERE order_id NOT IN (SELECT id FROM orders);  -- expect 0
SELECT count(*) AS track_left   FROM shipment_tracking WHERE order_id NOT IN (SELECT id FROM orders); -- expect 0
SELECT count(*) AS queue_left   FROM whatsapp_message_queue WHERE order_id NOT IN (SELECT id FROM orders)
       AND order_id IS NOT NULL;                                                                -- expect 0
-- 4b. no unrelated order was touched
SELECT id, order_number, status, tracking_number FROM orders ORDER BY created_at DESC LIMIT 20;

-- ---------------------------------------------------------------------------
-- STEP 3b (OPTIONAL) — delete confident test products found in STEP 1b.
-- ONLY run for products whose order_references = 0 in STEP 1b output.
-- Prefer the Admin Products UI (it hard-deletes unreferenced products and
-- archives referenced ones). Example for one id:
-- DELETE FROM products WHERE id = '<product-id-from-step-1b>'
--   AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = products.id);
-- ---------------------------------------------------------------------------
