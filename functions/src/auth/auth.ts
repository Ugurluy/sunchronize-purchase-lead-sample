import { getAuth, DecodedIdToken } from "firebase-admin/auth";
import { defineString } from "firebase-functions/params";
import type { Request } from "express";

const ADMIN_UIDS = defineString("ADMIN_UIDS", { default: "" });

type Role = "company" | "customer" | "admin";

type AuthenticatedCallableRequest = {
  headers?: { authorization?: string };
  rawRequest?: { headers?: { authorization?: string } };
  auth?: { token?: DecodedIdToken };
};

const ALLOWED_ORIGINS = [
  "https://<your-project-id>.web.app",
  "https://<your-project-id>.firebaseapp.com",
];

const throttleTracker: Record<string, number> = {};

export async function verifyUser(
  req: AuthenticatedCallableRequest | Request,
): Promise<DecodedIdToken | null> {
  const callableReq = req as AuthenticatedCallableRequest;

  if (callableReq?.auth?.token) {
    return callableReq.auth.token as DecodedIdToken;
  }

  const authHeader =
    callableReq?.headers?.authorization ??
    callableReq?.rawRequest?.headers?.authorization ??
    (req as Request)?.headers?.authorization ??
    "";

  const bearerMatch =
    typeof authHeader === "string" ? authHeader.match(/^Bearer\s+(.+)$/i) : null;
  if (!bearerMatch) return null;
  try {
    const idToken = bearerMatch[1];
    return await getAuth().verifyIdToken(idToken);
  } catch {
    return null;
  }
}

export function getRole(token: DecodedIdToken | null): Role | null {
  if (!token) return null;
  const raw = (token as any)?.role ?? (token as any)?.claims?.role ?? (token as any)?.token?.role;
  if (raw === "company" || raw === "customer" || raw === "admin") return raw;
  return null;
}

export function isAdminUid(uid: string): boolean {
  const list = ADMIN_UIDS.value()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(uid);
}

export function isOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

export function isThrottled(uid: string, key: string, windowMs: number): boolean {
  const now = Date.now();
  const throttleKey = `${uid}:${key}`;
  const last = throttleTracker[throttleKey] ?? 0;
  const within = now - last < windowMs;
  if (!within) throttleTracker[throttleKey] = now;
  return within;
}

export type { Role, AuthenticatedCallableRequest };
