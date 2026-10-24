// Excerpt of functions/src/index.ts: only the Admin SDK init and the export for this flow.
import { initializeApp } from "firebase-admin/app";

initializeApp();

export { purchaseLead } from "./leads/leads";
