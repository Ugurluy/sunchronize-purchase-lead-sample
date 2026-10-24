/**
 * Canonical lead status constants shared across all Cloud Functions.
 *
 * STATUS VOCABULARY
 * ─────────────────
 * pending    – customer submitted, waiting for company action
 * new        – alias for pending (legacy)
 * viewed     – company opened / unlocked the lead
 * unlocked   – alias for viewed (legacy)
 * quoted     – company sent a price quote
 * assigned   – company accepted, not yet scheduled
 * accepted   – alias for assigned
 * scheduled  – cleaning date set
 * in_progress– job currently underway
 * done       – alias for completed
 * completed  – work finished successfully
 * rejected   – company declined the lead
 * cancelled  – customer or company cancelled
 * expired    – lead's preferred/scheduled date passed with no progress
 */

// ── Individual status strings ──
export const S_PENDING = "pending" as const;
export const S_NEW = "new" as const;
export const S_VIEWED = "viewed" as const;
export const S_UNLOCKED = "unlocked" as const;
export const S_QUOTED = "quoted" as const;
export const S_ASSIGNED = "assigned" as const;
export const S_ACCEPTED = "accepted" as const;
export const S_SCHEDULED = "scheduled" as const;
export const S_IN_PROGRESS = "in_progress" as const;
export const S_DONE = "done" as const;
export const S_COMPLETED = "completed" as const;
export const S_REJECTED = "rejected" as const;
export const S_CANCELLED = "cancelled" as const;
export const S_EXPIRED = "expired" as const;
export const S_PAYMENT_REQUESTED = "payment_requested" as const;
export const S_PAID = "paid" as const;

// ── Status groups ──

/** Statuses that mean the lead has not yet been acted upon. */
export const PENDING_STATUSES: ReadonlySet<string> = new Set([S_PENDING, S_NEW]);

/** Statuses that mean the lead is actively being processed. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  S_ASSIGNED,
  S_ACCEPTED,
  S_SCHEDULED,
  S_IN_PROGRESS,
  S_VIEWED,
  S_UNLOCKED,
  S_QUOTED,
]);

/** Statuses from which no further transitions should occur. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  S_COMPLETED,
  S_DONE,
  S_CANCELLED,
  S_REJECTED,
  S_EXPIRED,
]);

/** Statuses that block a customer-initiated cancellation. */
export const NON_CANCELLABLE_STATUSES: ReadonlySet<string> = TERMINAL_STATUSES;

/** Job statuses that indicate the work has started or finished (no refund). */
export const JOB_STARTED_STATUSES: ReadonlySet<string> = new Set([
  S_IN_PROGRESS,
  S_COMPLETED,
  S_DONE,
  "started",
]);
