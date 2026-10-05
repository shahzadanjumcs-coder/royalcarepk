import { hashPassword } from "@/lib/auth/passwords";
import type { TableName } from "./base";

// Deterministic PRNG so seeded demo data is stable
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261002);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const NOW = new Date(now);
const daysAgoISO = (d: number, hour = randInt(9, 18), min = randInt(0, 59)) => {
  return new Date(now - d * DAY + (hour - 12) * 3600000 + min * 60000).toISOString();
};

type Row = Record<string, unknown> & { id: string };
const db: Record<string, Row[]> = {};
const put = (t: string, rows: Row[]) => {
  db[t] = (db[t] || []).concat(rows);
};

const id = (() => {
  let i = 0;
  return (p: string) => `${p}-${String(++i).padStart(4, "0")}`;
})();

// ---------------- Teams ----------------
const teams: Row[] = [
  { id: id("team"), name: "Karachi Central", description: "Central Karachi field team", status: "active", created_at: daysAgoISO(90) },
  { id: id("team"), name: "Lahore Zone", description: "Lahore & suburbs", status: "active", created_at: daysAgoISO(85) },
  { id: id("team"), name: "North Riders", description: "Islamabad / Rawalpindi", status: "active", created_at: daysAgoISO(70) },
];
put("teams", teams);

// ---------------- Profiles ----------------
const mkUser = (name: string, email: string, role: string, rate: number, teamIdx: number | null, createdDays: number): Row => ({
  id: id("usr"),
  email,
  name,
  phone: `03${randInt(0, 4)}${randInt(1000000, 9999999)}`,
  role,
  worker_code: role === "worker" ? `W-${String(workerCount + 1).padStart(4, "0")}` : `STF-${String(staffCount + 1).padStart(3, "0")}`,
  team_id: teamIdx === null ? null : teams[teamIdx].id,
  commission_rate: rate,
  status: "active",
  password_hash: hashPassword(role === "worker" ? "worker123" : "admin123"),
  created_at: daysAgoISO(createdDays),
  updated_at: daysAgoISO(createdDays),
});
let workerCount = 0;
let staffCount = 0;

const superAdmin = mkUser("Zara Ahmed", "admin@demo.com", "super_admin", 0, null, 120);
staffCount++;
const ownerAdmin = mkUser("RoyalCarePK Owner", "royalcarepk@gmail.com", "super_admin", 0, null, 130);
staffCount++;
const manager = mkUser("Hassan Raza", "manager@demo.com", "admin", 0, 0, 110);
staffCount++;
const invManager = mkUser("Fatima Khan", "inventory@demo.com", "inventory_manager", 0, null, 100);
staffCount++;

const workers: Row[] = [
  mkUser("Ali Hassan", "ali@demo.com", "worker", 5, 0, 95),
  mkUser("Ahmed Nawaz", "ahmed@demo.com", "worker", 7, 0, 92),
  mkUser("Usman Tariq", "usman@demo.com", "worker", 10, 1, 90),
  mkUser("Bilal Chaudhry", "bilal@demo.com", "worker", 6, 1, 80),
  mkUser("Sana Malik", "sana@demo.com", "worker", 8, 2, 75),
  mkUser("Kamran Akmal", "kamran@demo.com", "worker", 5.5, 2, 60),
];
workerCount = workers.length;
put("profiles", [ownerAdmin, superAdmin, manager, invManager, ...workers]);

const teamMembers: Row[] = [];
workers.forEach((w, i) => {
  teamMembers.push({
    id: id("tm"),
    team_id: (w.team_id as string),
    user_id: w.id,
    role_in_team: i % 3 === 0 ? "Senior Rider" : "Rider",
    joined_at: w.created_at,
  });
});
put("team_members", teamMembers);

// ---------------- Customers ----------------
const cities = ["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar", "Sialkot"];
const customerNames = [
  "Ayesha Siddiqui", "Mohammad Imran", "Hira Shah", "Danish Ali", "Nida Farooq",
  "Salman Butt", "Rabia Noor", "Tahir Mehmood", "Amna Riaz", "Faisal Qureshi",
  "Maryam javed", "Zubair Ahmed", "Iqra Bhatti", "Naveed Anjum",
];
const customers: Row[] = customerNames.map((name) => ({
  id: id("cus"),
  name,
  phone: `03${randInt(0, 4)}${randInt(1000000, 9999999)}`,
  email: rand() > 0.4 ? `${name.toLowerCase().replace(/[^a-z]/g, ".")}@gmail.com` : null,
  address: `House ${randInt(1, 400)}, Block ${pick(["A", "B", "C", "D"])}-${randInt(1, 9)}, ${pick(["Gulberg", "DHA Phase " + randInt(1, 6), "Bahria Town", "Model Town", "Clifton", "F-11"])}`,
  city: pick(cities),
  status: "active",
  notes: rand() > 0.8 ? "Prefers evening delivery" : null,
  created_at: daysAgoISO(randInt(30, 110)),
}));
put("customers", customers);

// ---------------- Categories / Suppliers / Products ----------------
const categories: Row[] = ["Fashion & Apparel", "Electronics", "Home & Kitchen", "Beauty & Care", "Sports & Fitness", "Kids & Toys"].map((name) => ({
  id: id("cat"),
  name,
  description: `${name} products`,
  status: "active",
  created_at: daysAgoISO(120),
}));
put("categories", categories);

const suppliers: Row[] = [
  ["Karachi Textiles Ltd", "Owais Siddiqui"], ["TechSource Traders", "Junaid Alam"], ["HomeMart Wholesale", "Shahid Iqbal"],
  ["GlowUp Cosmetics", "Mehwish Tariq"], ["SportZone Distributors", "Adnan Yousuf"],
].map(([name, contact]) => ({
  id: id("sup"),
  name,
  contact_person: contact,
  phone: `03${randInt(0, 4)}${randInt(1000000, 9999999)}`,
  email: `sales@${name.toLowerCase().replace(/[^a-z]/g, "")}.pk`,
  address: `Warehouse ${randInt(1, 50)}, ${pick(cities)}`,
  status: "active",
  created_at: daysAgoISO(115),
}));
put("suppliers", suppliers);

type P = { name: string; cat: number; sup: number; cost: number; price: number; stock: number };
const productDefs: P[] = [
  { name: "Men's Cotton Kurta", cat: 0, sup: 0, cost: 850, price: 1499, stock: 64 },
  { name: "Lawn 3-Piece Suit", cat: 0, sup: 0, cost: 1900, price: 3299, stock: 48 },
  { name: "Denim Jacket", cat: 0, sup: 0, cost: 2200, price: 3899, stock: 22 },
  { name: "Women's Embroidered Shawl", cat: 0, sup: 0, cost: 1500, price: 2799, stock: 35 },
  { name: "Wireless Earbuds Pro", cat: 1, sup: 1, cost: 1800, price: 3199, stock: 56 },
  { name: "Power Bank 20000mAh", cat: 1, sup: 1, cost: 2400, price: 4199, stock: 41 },
  { name: "Smart LED Bulb Pack", cat: 1, sup: 1, cost: 700, price: 1299, stock: 8 },
  { name: "Bluetooth Speaker X2", cat: 1, sup: 1, cost: 2100, price: 3699, stock: 27 },
  { name: "Phone Tripod Stand", cat: 1, sup: 1, cost: 450, price: 899, stock: 73 },
  { name: "Non-Stick Cookware Set", cat: 2, sup: 2, cost: 3200, price: 5499, stock: 18 },
  { name: "Stainless Steel Water Bottle", cat: 2, sup: 2, cost: 350, price: 749, stock: 96 },
  { name: "Air Fryer 5L", cat: 2, sup: 2, cost: 8500, price: 13999, stock: 12 },
  { name: "Memory Foam Pillow (2-pack)", cat: 2, sup: 2, cost: 1600, price: 2899, stock: 30 },
  { name: "Vitamin C Face Serum", cat: 3, sup: 3, cost: 600, price: 1199, stock: 84 },
  { name: "Argan Hair Oil", cat: 3, sup: 3, cost: 500, price: 999, stock: 6 },
  { name: "Makeup Brush Set (12pc)", cat: 3, sup: 3, cost: 750, price: 1499, stock: 52 },
  { name: "Sunblock SPF 60", cat: 3, sup: 3, cost: 550, price: 1099, stock: 44 },
  { name: "Yoga Mat Premium", cat: 4, sup: 4, cost: 1300, price: 2399, stock: 26 },
  { name: "Adjustable Dumbbell 10kg", cat: 4, sup: 4, cost: 3800, price: 6499, stock: 14 },
  { name: "Resistance Bands Set", cat: 4, sup: 4, cost: 400, price: 899, stock: 61 },
  { name: "Kids Building Blocks 120pc", cat: 5, sup: 4, cost: 950, price: 1799, stock: 38 },
  { name: "Remote Control Car", cat: 5, sup: 4, cost: 1700, price: 2999, stock: 19 },
];
let pIdx = 0;
const products: Row[] = productDefs.map((p) => {
  pIdx++;
  return {
    id: id("prd"),
    name: p.name,
    sku: `SKU-${String(pIdx).padStart(4, "0")}`,
    barcode: `88000${String(randInt(1000000, 9999999))}`,
    category_id: categories[p.cat].id,
    supplier_id: suppliers[p.sup].id,
    purchase_price: p.cost,
    selling_price: p.price,
    current_stock: 0, // filled chronologically below
    reserved_stock: 0,
    min_stock: randInt(5, 15),
    status: "active",
    created_at: daysAgoISO(112),
    updated_at: daysAgoISO(112),
    __initial: Math.round(p.stock * 1.6),
  };
});
put("products", products);

// Opening purchase movements (initial stock)
const openingMovements: Row[] = products.map((p) => ({
  id: id("mov"),
  product_id: p.id,
  order_id: null,
  type: "PURCHASE",
  quantity: p.__initial as number,
  reserved_change: 0,
  balance_after: p.__initial as number,
  reserved_after: 0,
  note: "Opening stock purchase",
  created_by: invManager.id,
  created_at: daysAgoISO(110),
}));
put("inventory_movements", openingMovements);

// ---------------- Flaship catalog (simulated live catalog) ----------------
// courier_id mirrors the Integration API `code` field (lowercase courier code)
const couriers: Row[] = [
  { code: "tcs", name: "TCS Overnight" },
  { code: "leopards", name: "Leopards Courier" },
  { code: "mp", name: "M&P Logistics" },
  { code: "trax", name: "Trax" },
  { code: "postex", name: "PostEx" },
  { code: "callcourier", name: "CallCourier" },
].map(({ code, name }) => ({
  id: id("flc"),
  courier_id: code,
  name,
  active: true,
  synced_at: daysAgoISO(3),
}));
put("flaship_couriers", couriers);

const cityDefs: [string, string][] = [
  ["Karachi", "Sindh"], ["Lahore", "Punjab"], ["Islamabad", "Federal"], ["Rawalpindi", "Punjab"],
  ["Faisalabad", "Punjab"], ["Multan", "Punjab"], ["Peshawar", "KP"], ["Sialkot", "Punjab"],
  ["Quetta", "Balochistan"], ["Hyderabad", "Sindh"], ["Sargodha", "Punjab"], ["Gujranwala", "Punjab"],
];
const flCities: Row[] = cityDefs.map(([name, province]) => ({
  id: id("flcity"),
  city_id: `ct_${name.toLowerCase()}`,
  name,
  province,
  active: true,
  synced_at: daysAgoISO(3),
}));
put("flaship_cities", flCities);

const pickups: Row[] = [
  ["Main Warehouse — Karachi", "Plot 45, Industrial Area, Site, Karachi", "Karachi", "021-34567890"],
  ["Lahore Fulfillment Hub", "Unit 12, Sundar Industrial Estate, Lahore", "Lahore", "042-35211234"],
  ["Islamabad Dispatch Point", "Shop 8, I-9 Markaz, Islamabad", "Islamabad", "051-4863322"],
].map(([name, address, city, contact]) => ({
  id: id("flp"),
  pickup_id: `pk_${name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12)}`,
  name, address, city, contact,
  active: true,
  synced_at: daysAgoISO(3),
}));
put("flaship_pickups", pickups);

// pickup↔courier mapping (mirrors Flaship's merchant_pickup_couriers): the
// demo catalog deliberately leaves some couriers unmapped so the booking UI's
// mapped-pickup filtering is exercised in simulator mode too.
const pickupLinks: Row[] = [
  ["tcs", pickups[0].pickup_id],
  ["tcs", pickups[2].pickup_id],
  ["leopards", pickups[0].pickup_id],
  ["leopards", pickups[1].pickup_id],
  ["mp", pickups[1].pickup_id],
].map(([courierId, pickupId]) => ({
  id: id("flpc"),
  courier_id: courierId as string,
  pickup_id: pickupId as string,
  synced_at: daysAgoISO(3),
}));
put("flaship_pickup_couriers", pickupLinks);

// ---------------- Orders ----------------
const orders: Row[] = [];
const orderItems: Row[] = [];
const orderHistory: Row[] = [];
const commissionTxns: Row[] = [];
const movements: Row[] = db.inventory_movements;
const shipments: Row[] = [];
const tracking: Row[] = [];

// initialize product live balances from opening stock
const stockNow: Record<string, { current: number; reserved: number }> = {};
products.forEach((p) => {
  stockNow[p.id] = { current: p.__initial as number, reserved: 0 };
});

let orderSeqByDay: Record<string, number> = {};
const statusPlan: { status: string; w: number }[] = [
  { status: "DELIVERED", w: 52 },
  { status: "RETURNED_AFTER_DELIVERY", w: 12 },
  { status: "IN_TRANSIT", w: 7 },
  { status: "BOOKED", w: 8 },
  { status: "ASSIGNED", w: 6 },
  { status: "PENDING", w: 5 },
  { status: "CREATED", w: 4 },
  { status: "CANCELLED", w: 6 },
];
const statusPool: string[] = [];
statusPlan.forEach((s) => { for (let i = 0; i < s.w; i++) statusPool.push(s.status); });

for (let d = 58; d >= 0; d--) {
  const dayOrders = randInt(1, 5);
  for (let o = 0; o < dayOrders; o++) {
    const createdDays = d;
    const createdAt = daysAgoISO(d);
    const dayKey = createdAt.slice(0, 10);
    orderSeqByDay[dayKey] = (orderSeqByDay[dayKey] || 0) + 1;
    const seq = String(orderSeqByDay[dayKey]).padStart(3, "0");
    const yy = dayKey.slice(2, 4), mm = dayKey.slice(5, 7), dd = dayKey.slice(8, 10);

    const worker = pick(workers);
    const customer = pick(customers);
    const plan = pick(statusPool);

    // items 1-3
    const nItems = randInt(1, 3);
    const usedProducts = new Set<number>();
    let subtotal = 0;
    const oid = id("ord");
    for (let it = 0; it < nItems; it++) {
      let pi = randInt(0, products.length - 1);
      let guard = 0;
      while (usedProducts.has(pi) && guard++ < 10) pi = randInt(0, products.length - 1);
      usedProducts.add(pi);
      const prod = products[pi];
      const qty = randInt(1, 2);
      const unit = prod.selling_price as number;
      subtotal += unit * qty;
      orderItems.push({
        id: id("oi"),
        order_id: oid,
        product_id: prod.id,
        product_name: prod.name,
        sku: prod.sku,
        quantity: qty,
        unit_price: unit,
        line_total: unit * qty,
      });
    }
    const discount = rand() > 0.75 ? randInt(100, 500) : 0;
    const total = subtotal - discount;

    const status = plan === "RETURNED_AFTER_DELIVERY" ? "RETURNED" : plan;
    const active = ["ASSIGNED", "BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan);

    const order: Row = {
      id: oid,
      order_number: `ORD-${yy}${mm}${dd}-${seq}`,
      customer_id: customer.id,
      worker_id: active ? worker.id : null,
      status,
      subtotal,
      discount,
      total,
      cod_amount: total,
      delivery_address: customer.address,
      city: customer.city,
      notes: rand() > 0.85 ? pick(["Call before delivery", "Leave with reception", "Gift wrap requested"]) : null,
      commission_rate: active ? (worker.commission_rate as number) : null,
      commission_rate_locked_at: active ? createdAt : null,
      booking_status: ["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan) ? "booked" : "not_booked",
      flaship_booking_id: ["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan) ? `FLB${randInt(10000000, 99999999)}` : null,
      tracking_number: ["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan) ? `CN${randInt(1000000000, 9999999999)}` : null,
      flaship_courier_name: ["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan) ? pick(couriers).name : null,
      pickup_location_name: ["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan) ? pickups[0].name : null,
      booking_error: null,
      booked_at: ["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan) ? daysAgoISO(Math.max(0, d - 1)) : null,
      last_synced_at: ["IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan) ? daysAgoISO(Math.max(0, d - 2)) : null,
      created_by: manager.id,
      created_at: createdAt,
      updated_at: createdAt,
    };
    orders.push(order);

    // history chain
    const hist = (status: string, at: string, note: string | null = null) =>
      orderHistory.push({ id: id("oh"), order_id: oid, status, note, created_by: manager.id, created_by_name: manager.name, created_at: at });
    hist("CREATED", createdAt, "Order created");
    if (plan !== "CREATED") hist("PENDING", createdAt);
    if (active) {
      const assignedAt = daysAgoISO(Math.max(0, d - 1));
      hist("ASSIGNED", assignedAt, `Assigned to ${worker.name}`);
      if (["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan)) {
        const bookedAt = daysAgoISO(Math.max(0, d - 1), randInt(12, 17));
        hist("BOOKED", bookedAt, `Booked with ${order.flaship_courier_name}, CN ${order.tracking_number}`);
        if (["IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan)) {
          const transitAt = daysAgoISO(Math.max(0, d - 2));
          hist("IN_TRANSIT", transitAt, "Parcel picked up by courier");
          if (plan === "DELIVERED" || plan === "RETURNED_AFTER_DELIVERY") {
            const deliveredAt = daysAgoISO(Math.max(0, d - 4));
            hist("DELIVERED", deliveredAt, plan === "RETURNED_AFTER_DELIVERY" ? "Delivered but later refused" : "COD collected and parcel delivered");
            if (plan === "RETURNED_AFTER_DELIVERY") {
              hist("RETURNED", daysAgoISO(Math.max(0, d - 6)), "Returned to warehouse; stock received back");
            }
          } else if (plan === "RETURNED") {
            // returned before delivery
            hist("RETURNED", daysAgoISO(Math.max(0, d - 4)), "Customer refused — returned to shipper");
          }
        }
      }
    }
    if (plan === "CANCELLED") {
      hist("CANCELLED", daysAgoISO(Math.max(0, d - 1)), "Cancelled by customer before booking");
    }

    // stock movements
    const move = (type: string, productId: string, qty: number, at: string, orderId: string | null, note: string) => {
      const s = stockNow[productId];
      let dq = 0, dr = 0;
      if (type === "ORDER_RESERVE") { dr = qty; }
      else if (type === "DELIVERY") { dq = -qty; dr = -qty; }
      else if (type === "RETURN") { dq = qty; }
      else if (type === "ORDER_RELEASE") { dr = -qty; }
      s.current += dq;
      s.reserved += dr;
      movements.push({
        id: id("mov"), product_id: productId, order_id: orderId, type,
        quantity: dq, reserved_change: dr,
        balance_after: s.current, reserved_after: s.reserved,
        note, created_by: manager.id, created_at: at,
      });
    };
    orderItems.filter((i) => i.order_id === oid).forEach((item) => {
      const qty = item.quantity as number;
      const at = createdAt;
      move("ORDER_RESERVE", item.product_id as string, qty, at, oid, `Reserved for ${order.order_number}`);
      if (["DELIVERED", "RETURNED_AFTER_DELIVERY"].includes(plan)) {
        move("DELIVERY", item.product_id as string, qty, daysAgoISO(Math.max(0, d - 4)), oid, `Finalized for ${order.order_number}`);
        if (plan === "RETURNED_AFTER_DELIVERY") {
          move("RETURN", item.product_id as string, qty, daysAgoISO(Math.max(0, d - 6)), oid, `Return received for ${order.order_number}`);
        }
      } else if (["CANCELLED"].includes(plan) || plan === "RETURNED") {
        move("ORDER_RELEASE", item.product_id as string, qty, daysAgoISO(Math.max(0, d - 4)), oid, `Reservation released for ${order.order_number}`);
      }
    });

    // commission ledger (idempotent model: one DELIVERED_COMMISSION + optional RETURN_ADJUSTMENT)
    if (["DELIVERED", "RETURNED_AFTER_DELIVERY"].includes(plan)) {
      const rate = worker.commission_rate as number;
      const amount = Math.round((total * rate) / 100);
      commissionTxns.push({
        id: id("ctx"),
        worker_id: worker.id,
        order_id: oid,
        type: "DELIVERED_COMMISSION",
        amount,
        rate,
        description: `${rate}% commission on delivered order ${order.order_number}`,
        created_at: daysAgoISO(Math.max(0, d - 4)),
      });
      if (plan === "RETURNED_AFTER_DELIVERY") {
        commissionTxns.push({
          id: id("ctx"),
          worker_id: worker.id,
          order_id: oid,
          type: "RETURN_ADJUSTMENT",
          amount: -amount,
          rate,
          description: `Return adjustment for ${order.order_number}`,
          created_at: daysAgoISO(Math.max(0, d - 6)),
        });
      }
    }

    // shipments + tracking for booked orders
    if (order.booking_status === "booked") {
      const sid = id("shp");
      shipments.push({
        id: sid, order_id: oid,
        courier_name: order.flaship_courier_name,
        tracking_number: order.tracking_number,
        booking_id: order.flaship_booking_id,
        destination_city: order.city,
        pickup_location: order.pickup_location_name,
        shipment_status: ["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"].includes(plan) ? (plan === "BOOKED" ? "BOOKED" : plan) : "BOOKED",
        booked_at: order.booked_at,
        last_synced_at: order.last_synced_at,
      });
      const checkpoints = [
        ["BOOKED", "Booking confirmed with courier"],
        ["PICKED_UP", "Parcel picked up from warehouse"],
        ["IN_TRANSIT", "Arrived at sorting facility"],
        ["OUT_FOR_DELIVERY", "Out for delivery"],
        ["DELIVERED", "Delivered — COD collected"],
        ["RETURNED", "Returned to shipper"],
      ];
      const upto =
        plan === "BOOKED" ? 1 : plan === "IN_TRANSIT" ? 3 :
        plan === "RETURNED" ? (rand() > 0.5 ? 6 : 2) : 5;
      for (let c = 0; c < upto; c++) {
        const [st, desc] = checkpoints[c];
        tracking.push({
          id: id("trk"), order_id: oid, shipment_id: sid,
          status: st, description: desc, location: pick(cityDefs.map((x) => x[0])),
          scanned_at: daysAgoISO(Math.max(0, d - 1 - c)),
          raw: null,
        });
      }
    }
  }
}
put("orders", orders);
put("order_items", orderItems);
put("order_status_history", orderHistory);
put("commission_transactions", commissionTxns);
put("shipments", shipments);
put("shipment_tracking", tracking);

// finalize product stock from simulation
products.forEach((p) => {
  p.current_stock = stockNow[p.id].current;
  p.reserved_stock = stockNow[p.id].reserved;
  delete p.__initial;
});

// ---------------- Worker payments ----------------
const payments: Row[] = [];
commissionTxns.forEach((t) => { void t; });
workers.forEach((w) => {
  const net = commissionTxns
    .filter((t) => t.worker_id === w.id)
    .reduce((s, t) => s + (t.amount as number), 0);
  if (net <= 0) return;
  const nPayments = randInt(1, 3);
  let paid = 0;
  for (let i = 0; i < nPayments; i++) {
    const share = i === nPayments - 1 ? Math.round(net * (0.55 + rand() * 0.3)) - paid : Math.round((net * (0.55 + rand() * 0.3)) / nPayments);
    if (share <= 0 || paid + share > net) break;
    paid += share;
    payments.push({
      id: id("pay"),
      worker_id: w.id,
      amount: share,
      method: pick(["CASH", "BANK_TRANSFER", "BANK_TRANSFER", "OTHER"]),
      payment_date: daysAgoISO(randInt(1, 30)),
      reference: `TRX-${randInt(100000, 999999)}`,
      note: null,
      created_by: manager.id,
      created_by_name: manager.name,
      created_at: daysAgoISO(randInt(1, 30)),
      worker_name: w.name,
    });
  }
});
put("worker_payments", payments);

// ---------------- Commission rules ----------------
const rules: Row[] = [
  { id: id("rule"), name: "Default Commission", worker_id: null, scope: "default", rate: 5, status: "active", note: "Applied when a worker has no specific rule", created_at: daysAgoISO(100) },
  ...workers.slice(0, 3).map((w) => ({
    id: id("rule"),
    name: `${w.name} — ${w.commission_rate}%`,
    worker_id: w.id,
    scope: "worker" as const,
    rate: w.commission_rate as number,
    status: "active",
    note: "Individual rule",
    created_at: daysAgoISO(80),
  })),
];
put("commission_rules", rules);

// ---------------- Notifications ----------------
const recentOrders = orders.slice(-6).reverse();
const notifications: Row[] = [];
recentOrders.forEach((o) => {
  notifications.push({
    id: id("ntf"),
    user_id: null,
    title: "New order created",
    message: `Order ${o.order_number} for ${(o.total as number).toLocaleString()} Rs was created.`,
    type: "info",
    link: `/admin/orders/${o.id}`,
    read: rand() > 0.5,
    created_at: o.created_at,
  });
});
notifications.push(
  { id: id("ntf"), user_id: null, title: "Low stock alert", message: "2 products are below minimum stock level.", type: "warning", link: "/admin/inventory", read: false, created_at: daysAgoISO(1) },
  { id: id("ntf"), user_id: null, title: "Returned parcel", message: "A parcel was returned by the courier and needs restocking.", type: "warning", link: "/admin/inventory/returns", read: false, created_at: daysAgoISO(2) },
  { id: id("ntf"), user_id: null, title: "Worker payment due", message: "Usman Tariq has pending commission to be paid.", type: "info", link: "/admin/accounts/pending", read: false, created_at: daysAgoISO(2) }
);
workers.forEach((w, i) => {
  const o = recentOrders[i % recentOrders.length];
  notifications.push({
    id: id("ntf"),
    user_id: w.id,
    title: "New order assigned",
    message: `Order ${o.order_number} has been assigned to you.`,
    type: "info",
    link: `/worker/orders/${o.id}`,
    read: false,
    created_at: daysAgoISO(randInt(0, 3)),
  });
});
put("notifications", notifications);

// ---------------- Audit logs ----------------
const audit: Row[] = [];
orders.slice(-20).forEach((o) => {
  audit.push({
    id: id("aud"),
    user_id: manager.id,
    user_name: manager.name,
    action: pick(["order.created", "order.status_changed", "order.assigned"]),
    entity: "orders",
    entity_id: o.id,
    old_data: null,
    new_data: { order_number: o.order_number, status: o.status },
    created_at: o.created_at,
  });
});
audit.push(
  { id: id("aud"), user_id: superAdmin.id, user_name: superAdmin.name, action: "auth.login", entity: "auth", entity_id: superAdmin.id, old_data: null, new_data: null, created_at: daysAgoISO(0, 9) },
  { id: id("aud"), user_id: manager.id, user_name: manager.name, action: "payment.created", entity: "worker_payments", entity_id: payments[0]?.id ?? null, old_data: null, new_data: { amount: payments[0]?.amount ?? 0 }, created_at: daysAgoISO(1) },
  { id: id("aud"), user_id: invManager.id, user_name: invManager.name, action: "inventory.stock_in", entity: "products", entity_id: products[0].id, old_data: null, new_data: { qty: 20 }, created_at: daysAgoISO(2) },
  { id: id("aud"), user_id: superAdmin.id, user_name: superAdmin.name, action: "user.created", entity: "profiles", entity_id: workers[5].id, old_data: null, new_data: { email: workers[5].email, role: "worker" }, created_at: daysAgoISO(60) }
);
put("audit_logs", audit);

// ---------------- Settings ----------------
put("settings", [
  { id: id("set"), key: "general", value: { business_name: "RoyalCarePK", currency: "PKR", phone: "021-111-222-333", address: "Plot 45, Industrial Area, Karachi", low_stock_threshold: 10 }, updated_at: daysAgoISO(90) },
  { id: id("set"), key: "branding", value: { brand_name: "RoyalCarePK", tagline: "Business Console", logo_url: null, mobile_logo_url: null, favicon_url: null, primary_color: "#10b981", secondary_color: "#0f172a" }, updated_at: daysAgoISO(90) },
  { id: id("set"), key: "flaship", value: { base_url: "https://partners.flaship.pk/api/integration", mode: "simulator", timeout_ms: 30000, endpoints: { catalog: "/catalog/", bookings: "/bookings/", tracking: "/orders/{cn}/tracking/" }, default_courier: couriers[0].courier_id, default_service_type: "overnight", default_pickup: pickups[0].pickup_id, default_weight: 0.5, auto_sync_tracking: true }, updated_at: daysAgoISO(30) },
  { id: id("set"), key: "commission", value: { default_rate: 5, deduct_on_return: true, pay_on_delivery_only: true }, updated_at: daysAgoISO(90) },
]);

export async function buildSeed(): Promise<Record<string, Row[]>> {
  return db;
}
