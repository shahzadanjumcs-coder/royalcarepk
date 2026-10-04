// ============================================================
// RoyalCarePK — Core domain types
// ============================================================

export type Role = "super_admin" | "admin" | "worker" | "inventory_manager";

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  admin: "Admin / Manager",
  worker: "Worker",
  inventory_manager: "Inventory Manager",
};

/** Roles that can access the admin dashboard */
export const ADMIN_ROLES: Role[] = ["super_admin", "admin", "inventory_manager"];

export type UserStatus = "active" | "disabled";

export interface Profile {
  id: string;
  email: string;
  name: string;
  phone: string;
  role: Role;
  worker_code: string;
  team_id: string | null;
  commission_rate: number; // percent, e.g. 5 = 5%
  status: UserStatus;
  cnic?: string | null;
  address?: string | null;
  created_at: string;
  updated_at: string;
  // joined
  team_name?: string | null;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  leader_id: string | null;
  status: "active" | "inactive";
  created_at: string;
  member_count?: number;
  leader_name?: string | null;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role_in_team: string;
  joined_at: string;
  user_name?: string;
  team_name?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  city: string;
  status: "active" | "disabled";
  notes: string | null;
  created_at: string;
  // aggregates
  total_orders?: number;
  delivered_orders?: number;
  returned_orders?: number;
  total_spending?: number;
}

export interface Category {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  created_at: string;
  product_count?: number;
}

export interface Supplier {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: "active" | "inactive";
  created_at: string;
  product_count?: number;
}

export interface Product {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category_id: string | null;
  supplier_id: string | null;
  purchase_price: number;
  selling_price: number;
  current_stock: number;
  reserved_stock: number;
  min_stock: number;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
  // joined / computed
  category_name?: string | null;
  supplier_name?: string | null;
  available_stock?: number;
  stock_value?: number;
}

export type MovementType =
  | "PURCHASE"
  | "STOCK_IN"
  | "STOCK_OUT"
  | "ORDER_RESERVE"
  | "ORDER_RELEASE"
  | "DELIVERY"
  | "RETURN"
  | "ADJUSTMENT";

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  PURCHASE: "Purchase",
  STOCK_IN: "Stock In",
  STOCK_OUT: "Stock Out",
  ORDER_RESERVE: "Order Reserved",
  ORDER_RELEASE: "Reservation Released",
  DELIVERY: "Delivered (Finalized)",
  RETURN: "Return Received",
  ADJUSTMENT: "Adjustment",
};

export interface InventoryMovement {
  id: string;
  product_id: string;
  order_id: string | null;
  type: MovementType;
  /** signed change applied to current_stock */
  quantity: number;
  /** signed change applied to reserved_stock */
  reserved_change: number;
  balance_after: number;
  reserved_after: number;
  note: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  product_name?: string;
  product_sku?: string;
  order_number?: string | null;
}

export type OrderStatus =
  | "CREATED"
  | "PENDING"
  | "ASSIGNED"
  | "BOOKED"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "RETURNED"
  | "CANCELLED";

export const ORDER_STATUSES: OrderStatus[] = [
  "CREATED",
  "PENDING",
  "ASSIGNED",
  "BOOKED",
  "IN_TRANSIT",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
];

export type BookingStatus = "not_booked" | "pending" | "booked" | "failed";

/** Worker order approval workflow — separate from the courier order_status. */
export type OrderApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export const APPROVAL_LABELS: Record<OrderApprovalStatus, string> = {
  PENDING: "Pending Approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string;
  sku: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface Order {
  id: string;
  order_number: string;
  customer_id: string;
  worker_id: string | null;
  status: OrderStatus;
  subtotal: number;
  discount: number;
  total: number;
  cod_amount: number;
  delivery_address: string;
  city: string;
  notes: string | null;
  /** commission rate snapshot (percent) captured when worker assigned */
  commission_rate: number | null;
  commission_rate_locked_at: string | null;
  // flaship
  booking_status: BookingStatus;
  flaship_booking_id: string | null;
  tracking_number: string | null;
  flaship_courier_name: string | null;
  pickup_location_name: string | null;
  booking_error: string | null;
  booked_at: string | null;
  last_synced_at: string | null;
  // worker approval workflow (PENDING only for worker-submitted orders)
  approval_status?: OrderApprovalStatus;
  submitted_at?: string | null;
  submitted_by?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  rejected_at?: string | null;
  rejected_by?: string | null;
  rejection_reason?: string | null;
  // historical worker identity (survives worker account deletion)
  worker_name_snapshot?: string | null;
  worker_email_snapshot?: string | null;
  worker_code_snapshot?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // joined
  customer_name?: string;
  customer_phone?: string;
  worker_name?: string | null;
  items?: OrderItem[];
  net_commission?: number | null;
  paid_amount?: number | null;
}

export interface OrderStatusHistory {
  id: string;
  order_id: string;
  status: OrderStatus;
  note: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface Shipment {
  id: string;
  order_id: string;
  courier_name: string;
  tracking_number: string;
  booking_id: string | null;
  destination_city: string;
  pickup_location: string | null;
  shipment_status: string;
  booked_at: string;
  last_synced_at: string | null;
}

export interface ShipmentTracking {
  id: string;
  order_id: string;
  shipment_id: string | null;
  status: string;
  description: string | null;
  location: string | null;
  scanned_at: string;
  raw: Record<string, unknown> | null;
}

export type CommissionType =
  | "DELIVERED_COMMISSION"
  | "RETURN_ADJUSTMENT"
  | "MANUAL_ADJUSTMENT";

export const COMMISSION_TYPE_LABELS: Record<CommissionType, string> = {
  DELIVERED_COMMISSION: "Delivered Commission",
  RETURN_ADJUSTMENT: "Return Adjustment",
  MANUAL_ADJUSTMENT: "Manual Adjustment",
};

export interface CommissionTransaction {
  id: string;
  worker_id: string | null;
  /** captured at insert time; survives worker account deletion */
  worker_name_snapshot?: string | null;
  order_id: string | null;
  type: CommissionType;
  /** signed amount; positive credits, negative deductions */
  amount: number;
  /** percent snapshot used for this calculation */
  rate: number | null;
  description: string | null;
  created_at: string;
  // joined
  worker_name?: string;
  order_number?: string | null;
  cod_amount?: number | null;
}

export interface CommissionRule {
  id: string;
  name: string;
  worker_id: string | null;
  scope: "default" | "worker";
  rate: number;
  status: "active" | "inactive";
  note: string | null;
  created_at: string;
  worker_name?: string | null;
}

export type PaymentMethod = "CASH" | "BANK_TRANSFER" | "OTHER";

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank Transfer",
  OTHER: "Other",
};

export interface WorkerPayment {
  id: string;
  worker_id: string | null;
  /** captured at insert time; survives worker account deletion */
  worker_name_snapshot?: string | null;
  amount: number;
  method: PaymentMethod;
  payment_date: string;
  reference: string | null;
  note: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  worker_name?: string;
}

export interface WorkerEarnings {
  worker_id: string;
  delivered_commission: number;
  return_adjustment: number;
  manual_adjustment: number;
  net_commission: number;
  paid_amount: number;
  remaining_amount: number;
}

// ---------------- Flaship ----------------

export interface FlashipCourier {
  id: string;
  courier_id: string;
  name: string;
  active: boolean;
  synced_at: string | null;
}

export interface FlashipCity {
  id: string;
  city_id: string;
  name: string;
  province: string | null;
  active: boolean;
  synced_at: string | null;
}

export interface FlashipPickup {
  id: string;
  pickup_id: string;
  name: string;
  address: string | null;
  city: string | null;
  contact: string | null;
  active: boolean;
  synced_at: string | null;
}

export interface FlashipLog {
  id: string;
  order_id: string | null;
  order_number?: string | null;
  endpoint: string;
  method: string;
  status_code: number | null;
  success: boolean;
  duration_ms: number;
  request_redacted: string | null;
  response: string | null;
  error: string | null;
  created_at: string;
}

// ---------------- System ----------------

export interface AppNotification {
  id: string;
  user_id: string | null; // null = all admins
  title: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  link: string | null;
  read: boolean;
  created_at: string;
}

export interface AuditLog {
  id: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
}

export interface SettingRow {
  id: string;
  key: string;
  value: Record<string, unknown>;
  updated_at: string;
}

// ---------------- Session & shared ----------------

export interface Session {
  userId: string;
  email: string;
  name: string;
  role: Role;
  mode: "demo" | "supabase";
}

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export interface ListParams {
  page?: number;
  perPage?: number;
  search?: string;
  status?: string | null;
  filters?: Record<string, string | number | boolean | null | undefined>;
  dateFrom?: string | null;
  dateTo?: string | null;
  dateField?: string;
  orderBy?: string;
  orderDir?: "asc" | "desc";
}

export interface ApiError {
  error: string;
}

// ---------------- Dashboard / Reports ----------------

export interface DashboardStats {
  totalOrders: number;
  todayOrders: number;
  pendingOrders: number;
  inTransit: number;
  delivered: number;
  returned: number;
  cancelled: number;
  booked: number;
  totalSales: number;
  totalCOD: number;
  stockValue: number;
  lowStockProducts: number;
  totalCommission: number;
  paidCommission: number;
  pendingPayments: number;
  netCommission: number;
}

export interface TimeSeriesPoint {
  date: string;
  label: string;
  orders: number;
  delivered: number;
  returned: number;
  sales: number;
}

export type ReportType =
  | "sales"
  | "orders"
  | "delivered"
  | "returned"
  | "worker-performance"
  | "worker-commission"
  | "worker-payments"
  | "pending-payments"
  | "inventory"
  | "stock-movement"
  | "product-sales"
  | "customer";

export interface ReportTable {
  columns: { key: string; label: string; type?: "text" | "number" | "currency" | "date" }[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, number>;
}
