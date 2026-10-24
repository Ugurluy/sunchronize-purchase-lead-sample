import * as admin from "firebase-admin";
import { getFirestore, Transaction } from "firebase-admin/firestore";

type CreditChangeParams = {
  companyId: string;
  delta: number;
  reason: string;
  refId?: string;
  context?: Record<string, unknown>;
  actorUid?: string;
  actorRole?: string;
  requestId?: string;
  traceId?: string;
  balanceBefore?: number;
  balanceAfter?: number;
  amount?: number;
  leadId?: string;
  jobId?: string;
  source?: string;
  reasonCode?: string;
  notes?: string;
};

/** With `tx`, the audit entry commits atomically with the balance change. */
async function recordCreditChange(params: CreditChangeParams, tx?: Transaction) {
  const {
    companyId,
    delta,
    reason,
    refId,
    context,
    actorUid,
    actorRole,
    requestId,
    traceId,
    balanceBefore,
    balanceAfter,
    amount,
    leadId,
    jobId,
    source,
    reasonCode,
    notes,
  } = params;
  const db = getFirestore();
  const audits = db.collection("companies").doc(companyId).collection("creditAudits");
  const entry = {
    delta,
    reason,
    refId: refId ?? null,
    context: context ?? null,
    actorUid: actorUid ?? null,
    actorRole: actorRole ?? null,
    requestId: requestId ?? null,
    traceId: traceId ?? null,
    balanceBefore: typeof balanceBefore === "number" ? balanceBefore : null,
    balanceAfter: typeof balanceAfter === "number" ? balanceAfter : null,
    amount: typeof amount === "number" ? amount : Math.abs(delta),
    leadId: leadId ?? null,
    jobId: jobId ?? null,
    source: source ?? null,
    reasonCode: reasonCode ?? null,
    notes: notes ?? null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (tx) {
    tx.set(audits.doc(), entry);
  } else {
    await audits.add(entry);
  }
}

export async function deductCredit(
  params: Omit<CreditChangeParams, "delta"> & { amount: number },
  tx?: Transaction,
) {
  const { amount, ...rest } = params;
  const delta = -Math.abs(amount);
  await recordCreditChange({ ...rest, delta, amount: Math.abs(amount) }, tx);
}

export async function refundCredit(params: Omit<CreditChangeParams, "delta"> & { amount: number }) {
  const { amount, ...rest } = params;
  const delta = Math.abs(amount);
  await recordCreditChange({ ...rest, delta, amount: Math.abs(amount) });
}
