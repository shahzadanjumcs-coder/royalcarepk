"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/utils";

const AXIS = { fontSize: 11, fill: "#64748b" };
const GRID = "#e2e8f0";

const tooltipStyle = {
  borderRadius: 10,
  border: "1px solid #e2e8f0",
  fontSize: 12,
  boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
};

export function OrdersAreaChart({ data }: { data: { label: string; orders: number; delivered: number; returned: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="gOrders" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} />
        <Area type="monotone" dataKey="orders" name="Orders" stroke="#10b981" strokeWidth={2} fill="url(#gOrders)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function DeliveredReturnedChart({ data }: { data: { label: string; delivered: number; returned: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="delivered" name="Delivered" fill="#10b981" radius={[3, 3, 0, 0]} />
        <Bar dataKey="returned" name="Returned" fill="#f43f5e" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SalesBarChart({ data }: { data: { label: string; sales: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
        />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatCurrency(Number(v))} />
        <Bar dataKey="sales" name="Sales" fill="#0d9488" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const STATUS_COLORS: Record<string, string> = {
  DELIVERED: "#10b981",
  RETURNED: "#f43f5e",
  IN_TRANSIT: "#14b8a6",
  BOOKED: "#38bdf8",
  ASSIGNED: "#8b5cf6",
  PENDING: "#f59e0b",
  CREATED: "#94a3b8",
  CANCELLED: "#a1a1aa",
};

export function StatusPieChart({ data }: { data: { status: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie data={data} dataKey="count" nameKey="status" innerRadius={55} outerRadius={90} paddingAngle={2} strokeWidth={0}>
          {data.map((d) => (
            <Cell key={d.status} fill={STATUS_COLORS[d.status] ?? "#94a3b8"} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend
          layout="vertical"
          align="right"
          verticalAlign="middle"
          formatter={(v) => String(v).replace(/_/g, " ")}
          wrapperStyle={{ fontSize: 11, maxWidth: 120 }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function WorkerPerformanceChart({ data }: { data: { name: string; delivered: number; returned: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 30, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="name" tick={{ ...AXIS, fontSize: 11 }} tickLine={false} axisLine={false} width={90} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="delivered" name="Delivered" fill="#10b981" radius={[0, 3, 3, 0]} />
        <Bar dataKey="returned" name="Returned" fill="#fda4af" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CommissionLineChart({ data }: { data: { label: string; sales: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
        />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatCurrency(Number(v))} />
        <Line type="monotone" dataKey="sales" name="Sales value" stroke="#f59e0b" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function InventoryMovementChart({ data }: { data: { label: string; in: number; out: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="in" name="Stock in / returns" fill="#10b981" radius={[3, 3, 0, 0]} />
        <Bar dataKey="out" name="Delivered / out" fill="#f43f5e" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
