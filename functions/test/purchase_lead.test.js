/* eslint-disable @typescript-eslint/no-var-requires */
// Runs against the Firestore and Auth emulators: `npm run test:purchase-lead`.
const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const PROJECT = "demo-purchase-lead";
process.env.GCLOUD_PROJECT = PROJECT;
// Against the Auth emulator, verifyIdToken accepts unsigned tokens.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";

const { initializeApp } = require("firebase-admin/app");
initializeApp({ projectId: PROJECT });
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { purchaseLead } = require("../lib/leads/leads");

const db = getFirestore();

/** verifyIdToken looks the user up in the Auth emulator to reject disabled accounts. */
async function createCompanyUser(uid, credits) {
  await getAuth().createUser({ uid });
  await db.doc(`companies/${uid}`).set({ credits });
}

function idToken(uid, role = "company") {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: uid,
    user_id: uid,
    auth_time: now,
    iat: now,
    exp: now + 3600,
    role,
  };
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`;
}

/** Invokes the deployed handler with a minimal Express-like req/res. */
function callPurchaseLead(uid, body) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${idToken(uid)}` };
    const req = { method: "POST", headers, body, header: (n) => headers[n.toLowerCase()] };
    const res = new EventEmitter();
    const resHeaders = {};
    res.statusCode = 200;
    res.setHeader = (k, v) => (resHeaders[k.toLowerCase()] = v);
    res.getHeader = (k) => resHeaders[k.toLowerCase()];
    res.status = (code) => ((res.statusCode = code), res);
    res.json = (payload) => {
      resolve({ status: res.statusCode, body: payload });
      res.emit("finish");
      return res;
    };
    Promise.resolve(purchaseLead(req, res)).catch(reject);
  });
}

async function seed({ companyId, credits, leadId, leadCompanyId = companyId }) {
  await createCompanyUser(companyId, credits);
  await db.doc(`leads/${leadId}`).set({
    companyId: leadCompanyId,
    customerId: "customer-1",
    status: "pending",
    revealed: false,
    unlockedBy: [],
  });
}

const audits = (companyId) => db.collection(`companies/${companyId}/creditAudits`).get();

test("no credits returns 402 and leaves the lead locked", async () => {
  await seed({ companyId: "broke-co", credits: 0, leadId: "lead-402" });

  const res = await callPurchaseLead("broke-co", { leadId: "lead-402" });

  assert.equal(res.status, 402);
  assert.equal(res.body.error, "no_credits");
  assert.equal((await db.doc("leads/lead-402").get()).data().revealed, false);
  assert.equal((await audits("broke-co")).size, 0);
});

test("a lead addressed to another company returns 403 and charges nothing", async () => {
  await seed({
    companyId: "intruder-co",
    credits: 5,
    leadId: "lead-403",
    leadCompanyId: "owner-co",
  });

  const res = await callPurchaseLead("intruder-co", { leadId: "lead-403" });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, "not_your_lead");
  assert.equal((await db.doc("companies/intruder-co").get()).data().credits, 5);
});

test("an unknown lead returns 404", async () => {
  await createCompanyUser("lost-co", 5);

  const res = await callPurchaseLead("lost-co", { leadId: "does-not-exist" });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, "lead_not_found");
});

test("a leadId that is not a plain document ID returns 400 before any read", async () => {
  await createCompanyUser("path-co", 5);

  const res = await callPurchaseLead("path-co", { leadId: "x/y" });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_leadId");
});

test("success charges exactly one credit, once, with one audit entry", async () => {
  await seed({ companyId: "paying-co", credits: 3, leadId: "lead-ok" });

  const first = await callPurchaseLead("paying-co", { leadId: "lead-ok" });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "unlocked");
  assert.equal(first.body.creditsRemaining, 2);

  const lead = (await db.doc("leads/lead-ok").get()).data();
  assert.equal(lead.revealed, true);
  assert.deepEqual(lead.unlockedBy, ["paying-co"]);

  // The handler throttles each company to one call per 2 s.
  await new Promise((r) => setTimeout(r, 2100));
  const repeat = await callPurchaseLead("paying-co", { leadId: "lead-ok" });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.status, "already_unlocked");

  assert.equal((await db.doc("companies/paying-co").get()).data().credits, 2);
  const entries = await audits("paying-co");
  assert.equal(entries.size, 1);
  const entry = entries.docs[0].data();
  assert.equal(entry.delta, -1);
  assert.equal(entry.balanceBefore, 3);
  assert.equal(entry.balanceAfter, 2);
  assert.equal(entry.leadId, "lead-ok");
});

test("an already unlocked lead returns 200 and charges nothing", async () => {
  await seed({ companyId: "open-co", credits: 4, leadId: "lead-open" });
  await db.doc("leads/lead-open").update({
    revealed: true,
    unlockedBy: ["open-co"],
  });

  const res = await callPurchaseLead("open-co", { leadId: "lead-open" });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "already_unlocked");
  assert.equal(res.body.creditsRemaining, 4);
  assert.equal((await db.doc("companies/open-co").get()).data().credits, 4);
  assert.equal((await audits("open-co")).size, 0);
});
