"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, CheckCheck, Loader2, XCircle } from "lucide-react";

export interface ApproveResponse {
  order: { id: string; order_number: string; approval_status?: string; tracking_number?: string | null; booking_error?: string | null };
  booking: { bookingId: string; trackingNumber: string; courierName: string } | null;
  alreadyBooked?: boolean;
  bookingAttempted?: boolean;
  bookingError?: string;
}

/**
 * Approve + Reject actions for a pending worker order, shared by the admin
 * dashboard card and the order detail page. Approve confirms first (it
 * triggers Flaship booking); Reject requires a non-empty reason and blocks
 * empty submissions client-side and server-side.
 */
export function ApprovalActions({
  orderId,
  orderNumber,
  size = "sm",
  onDone,
}: {
  orderId: string;
  orderNumber: string;
  size?: "sm" | "default";
  onDone?: (result: { kind: "approved"; res: ApproveResponse } | { kind: "rejected"; reason: string }) => void;
}) {
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  const approve = async () => {
    setBusy("approve");
    setError(null);
    try {
      const res = await api<ApproveResponse>(`/api/orders/${orderId}/approve`, { method: "POST" });
      setApproveOpen(false);
      onDone?.({ kind: "approved", res });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Approval failed. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError("A rejection reason is required.");
      return;
    }
    setBusy("reject");
    setError(null);
    try {
      await api(`/api/orders/${orderId}/reject`, { method: "POST", json: { reason: trimmed } });
      setRejectOpen(false);
      setReason("");
      setReasonError(null);
      onDone?.({ kind: "rejected", reason: trimmed });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Rejection failed. Please try again.";
      // Surface server-side validation (e.g. missing reason) inside the dialog
      setReasonError(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Button size={size} className="bg-emerald-600 hover:bg-emerald-700" disabled={busy !== null} onClick={() => { setError(null); setApproveOpen(true); }}>
          {busy === "approve" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="mr-1.5 h-3.5 w-3.5" />}
          Approve
        </Button>
        <Button size={size} variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" disabled={busy !== null} onClick={() => { setError(null); setReasonError(null); setRejectOpen(true); }}>
          {busy === "reject" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <XCircle className="mr-1.5 h-3.5 w-3.5" />}
          Reject
        </Button>
      </div>

      {/* Approve confirmation — explains the Flaship side effect */}
      <Dialog open={approveOpen} onOpenChange={(o) => (!busy ? setApproveOpen(o) : undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve order {orderNumber}?</DialogTitle>
            <DialogDescription>
              Approving marks the order as approved and immediately books it with Flaship using the default courier and
              pickup location. If booking fails, the order stays approved and you can retry safely — duplicate shipments
              are blocked automatically.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{error}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy !== null} onClick={() => setApproveOpen(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={busy !== null} onClick={approve}>
              {busy === "approve" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <AlertTriangle className="mr-2 h-4 w-4" />}
              Approve &amp; book
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog — reason is mandatory */}
      <Dialog open={rejectOpen} onOpenChange={(o) => (!busy ? setRejectOpen(o) : undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject order {orderNumber}</DialogTitle>
            <DialogDescription>
              The worker will be notified with your reason. The order will be cancelled and its stock reservation
              released. Rejection cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`reject-reason-${orderId}`}>Reason *</Label>
            <Textarea
              id={`reject-reason-${orderId}`}
              rows={3}
              value={reason}
              onChange={(e) => { setReason(e.target.value); setReasonError(null); }}
              placeholder="e.g. Customer address is incomplete."
              aria-invalid={!!reasonError}
            />
            {reasonError ? <p className="text-xs text-rose-600" role="alert">{reasonError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy !== null} onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700" disabled={busy !== null} onClick={reject}>
              {busy === "reject" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
              Reject order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
