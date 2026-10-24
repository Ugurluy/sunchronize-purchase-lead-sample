// Excerpt of functions/src/leads/leads.ts (960 lines in the real repo).
// Only purchaseLead is kept; imports were trimmed to the ones it uses.
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { verifyUser, isOriginAllowed, isThrottled, getRole } from "../auth/auth";
import { deductCredit } from "../credits/credits";
import { S_VIEWED } from "./lead_statuses";

export const purchaseLead = onRequest(
  {
    region: "europe-west1",
    cors: true,
    timeoutSeconds: 20,
    memory: "256MiB",
  },
  async (req, res): Promise<void> => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    if (!isOriginAllowed(req.headers.origin)) {
      res.status(403).json({ error: "forbidden_origin" });
      return;
    }

    try {
      const user = await verifyUser(req as any);
      if (!user) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      if (isThrottled(user.uid, "purchaseLead", 2000)) {
        logger.warn("throttled_purchaseLead", { uid: user.uid });
        res.status(429).json({ error: "too_many_requests" });
        return;
      }

      const role = getRole(user as any);
      if (role && role !== "company" && role !== "admin") {
        logger.warn("purchaseLead role_mismatch", { uid: user.uid, role });
        res.status(403).json({ error: "forbidden_role" });
        return;
      }

      const { leadId } = req.body ?? {};
      const traceId = (req.headers["x-cloud-trace-context"] || req.headers["traceparent"]) as
        | string
        | undefined;
      const requestId = (req.headers["x-request-id"] || req.headers["request-id"]) as
        | string
        | undefined;
      if (!leadId || typeof leadId !== "string") {
        res.status(400).json({ error: "missing_leadId" });
        return;
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) {
        res.status(400).json({ error: "invalid_leadId" });
        return;
      }

      const db = getFirestore();
      const companyId = user.uid;

      const companyRef = db.collection("companies").doc(companyId);
      const companySnap = await companyRef.get();
      if (!companySnap.exists) {
        res.status(403).json({ error: "not_company" });
        return;
      }

      const companyData = companySnap.data() ?? {};
      const credits = typeof companyData.credits === "number" ? companyData.credits : 0;
      const demoEnabled = companyData.demoEnabled === true;
      const demoExpiresAt = companyData.demoExpiresAt as Timestamp | undefined;

      const nowMs = Date.now();
      const demoActive = demoEnabled && !!demoExpiresAt && demoExpiresAt.toMillis() > nowMs;

      const leadRef = db.collection("leads").doc(leadId);
      const leadSnap = await leadRef.get();

      if (!leadSnap.exists) {
        res.status(404).json({ error: "lead_not_found" });
        return;
      }

      const leadData = leadSnap.data() ?? {};

      if (leadData.companyId !== companyId) {
        res.status(403).json({ error: "not_your_lead" });
        return;
      }

      const unlockedBy: string[] = Array.isArray(leadData.unlockedBy) ? leadData.unlockedBy : [];

      const alreadyUnlocked = leadData.revealed === true || unlockedBy.includes(companyId);

      if (alreadyUnlocked) {
        res.status(200).json({
          ok: true,
          status: "already_unlocked",
          leadId,
          creditsRemaining: credits,
          demoActive,
        });
        return;
      }

// Demo period, enabled by an admin: unlock without charging a credit for beta testing.
      if (demoActive) {
        const updatedAt = FieldValue.serverTimestamp();
        const ts = Timestamp.now();
        await leadRef.update({
          revealed: true,
          purchasedAt: FieldValue.serverTimestamp(),
          unlockedBy: FieldValue.arrayUnion(companyId),
          status: S_VIEWED,
          updatedAt,
          statusHistory: FieldValue.arrayUnion({
            status: S_VIEWED,
            ts,
          }),
        });

        res.status(200).json({
          ok: true,
          status: "demo_unlocked",
          leadId,
          creditsRemaining: credits,
          demoActive: true,
          demoExpiresAt: demoExpiresAt?.toDate().toISOString() ?? null,
        });
        return;
      }

      if (credits <= 0) {
        res.status(402).json({
          ok: false,
          error: "no_credits",
          creditsRemaining: credits,
          demoActive: false,
        });
        return;
      }

      const result = await db.runTransaction(async (tx) => {
        const companySnapTx = await tx.get(companyRef);
        const leadSnapTx = await tx.get(leadRef);

        if (!companySnapTx.exists) {
          throw new Error("company_not_found");
        }
        if (!leadSnapTx.exists) {
          throw new Error("lead_not_found");
        }

        const cData = companySnapTx.data() ?? {};
        const lData = leadSnapTx.data() ?? {};

        const curCredits = typeof cData.credits === "number" ? cData.credits : 0;
        const curUnlockedBy: string[] = Array.isArray(lData.unlockedBy) ? lData.unlockedBy : [];

        if (lData.companyId !== companyId) {
          throw new Error("not_your_lead");
        }
        if (curUnlockedBy.includes(companyId) || lData.revealed === true) {
          return { charged: false, creditsRemaining: curCredits };
        }

        if (curCredits <= 0) {
          throw new Error("no_credits");
        }

        tx.update(companyRef, {
          credits: FieldValue.increment(-1),
        });

        const updatedAt = FieldValue.serverTimestamp();
        const ts = Timestamp.now();
        tx.update(leadRef, {
          revealed: true,
          purchasedAt: FieldValue.serverTimestamp(),
          unlockedBy: FieldValue.arrayUnion(companyId),
          status: S_VIEWED,
          updatedAt,
          statusHistory: FieldValue.arrayUnion({
            status: S_VIEWED,
            ts,
          }),
        });

        await deductCredit(
          {
            companyId,
            amount: 1,
            reason: "lead_purchase",
            reasonCode: "lead_purchase",
            refId: leadId,
            leadId,
            balanceBefore: curCredits,
            balanceAfter: curCredits - 1,
            actorUid: user.uid,
            actorRole: role ?? undefined,
            requestId,
            traceId,
            source: "purchase_lead",
          },
          tx,
        );
        return { charged: true, creditsRemaining: curCredits - 1 };
      });

      res.status(200).json({
        ok: true,
        status: result.charged ? "unlocked" : "already_unlocked",
        leadId,
        creditsRemaining: result.creditsRemaining,
        demoActive: false,
      });
    } catch (e: any) {
      logger.error("purchaseLead_failed", { msg: String(e?.message || e) });

      if (String(e?.message) === "no_credits") {
        res.status(402).json({ ok: false, error: "no_credits" });
        return;
      }

      res.status(500).json({ ok: false, error: "server_error" });
    }
  },
);
