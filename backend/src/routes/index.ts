/**
 * M2 handler map, keyed by the contract's operation id.
 *
 * An operation with no entry is documented but not served — that is how "implemented"
 * stays distinguishable from "documented" (IMPLEMENTATION_PLAN milestones), without
 * inventing placeholder routes. M3+ adds entries; the registry itself is the contract.
 */
import type { Handler } from "../http/router.js";
import {
  auth01Login,
  auth02Logout,
  auth03Me,
  auth04ChangePassword,
  auth05AcceptInvite,
  auth06ListSessions,
  auth06RevokeSession,
  auth07Confirm,
  auth07Disable,
  auth07Enroll,
} from "./auth.js";
import {
  usr01List,
  usr02Create,
  usr03Get,
  usr03Update,
  usr04Disable,
  usr04Enable,
  usr05ResetPassword,
} from "./users.js";
import { sys01, sys02 } from "./system.js";
import {
  set01Read,
  set01Update,
  set02Read,
  set02Update,
  set03UploadLogo,
  set04Create,
  set04List,
  set04Update,
} from "./settings.js";
import {
  cch01List,
  cch02List,
  cch03Create,
  cch04End,
  cch05MyGroups,
  fee01List,
  fee02Create,
  grp01List,
  grp02Create,
  grp03Read,
  grp03Update,
  grp04Archive,
  grp04Unarchive,
  grp05Suggest,
} from "./groups.js";
import {
  ply01List,
  ply02Create,
  ply03Read,
  ply04Update,
  ply05Status,
  ply06Transfer,
  ply07GroupHistory,
  ply08CheckDuplicates,
  ply09Invoices,
  ply10Attendance,
  ply11Balance,
} from "./players.js";
import {
  gdn01List,
  gdn02Update,
  gdn03Link,
  gdn04Delete,
  gdn04Update,
  gdn05Consent,
  gdn06Balance,
} from "./guardians.js";
import { imp01Validate, imp02Commit } from "./imports.js";
import {
  sch01Create,
  sch01Deactivate,
  sch01List,
  sch01Update,
  sch02Generate,
} from "./schedules.js";
import {
  ses01List,
  ses02Create,
  ses03Read,
  ses03Update,
  ses04Cancel,
} from "./sessions.js";
import { att01Read, att02Save, att03Correct } from "./attendance.js";
import {
  pay01List,
  pay02Create,
  pay03Read,
  pay03Update,
  pay04Confirm,
  pay05Reject,
  pay06Allocate,
  pay07Reverse,
  pay08Suggestion,
} from "./payments.js";
import { prf01Upload, prf02Download, prf03Delete, prf04Verify } from "./proofs.js";
import { pub01InvoicePdf, pub02Logo } from "./public.js";
import { rct01List, rct02Download, rct02Regenerate } from "./receipts.js";
import { bil01Preview, bil02Run, bil03List, bil03Read } from "./billing.js";
import { inv01List, inv02Read, inv03Create, inv04Void, inv05Adjust } from "./invoices.js";
import { inv06Download, inv07Regenerate } from "./invoice-pdf.js";
import {
  cat01CheckIn,
  cat02CheckOut,
  cat03List,
  cat04Create,
  cat05Correct,
} from "./coach-time.js";
import { dsh02Coach } from "./dashboard.js";
// M8 — DSH-01 (owner dashboard), RPT-01/02 (reports + CSV), AUD-01, SYS-03
import { dsh01Owner } from "./owner-dashboard.js";
import { rpt01Run, rpt02Export } from "./reports.js";
import { aud01List } from "./audit.js";
import { sys03Health } from "./system-detail.js";

export const handlers: Map<string, Handler> = new Map<string, Handler>([
  // AUTH-01..07
  ["AUTH-01", auth01Login],
  ["AUTH-02", auth02Logout],
  ["AUTH-03", auth03Me],
  ["AUTH-04", auth04ChangePassword],
  ["AUTH-05", auth05AcceptInvite],
  ["AUTH-06.list", auth06ListSessions],
  ["AUTH-06.revoke", auth06RevokeSession],
  ["AUTH-07.enroll", auth07Enroll],
  ["AUTH-07.confirm", auth07Confirm],
  ["AUTH-07.disable", auth07Disable],
  // USR-01..05
  ["USR-01", usr01List],
  ["USR-02", usr02Create],
  ["USR-03.get", usr03Get],
  ["USR-03.update", usr03Update],
  ["USR-04.disable", usr04Disable],
  ["USR-04.enable", usr04Enable],
  ["USR-05", usr05ResetPassword],
  // SET-01/SET-02 (academy profile, billing configuration)
  ["SET-01.read", set01Read],
  ["SET-01.update", set01Update],
  ["SET-02.read", set02Read],
  ["SET-02.update", set02Update],
  // SET-04 — payment methods (list/create/update)
  ["SET-04.list", set04List],
  ["SET-04.create", set04Create],
  ["SET-04.update", set04Update],
  // SYS-01/02 (health and readiness)
  ["SYS-01", sys01],
  ["SYS-02", sys02],
  // M3 — GRP-01..05, FEE-01/02 (age groups and fees)
  ["GRP-01", grp01List],
  ["GRP-02", grp02Create],
  ["GRP-03.read", grp03Read],
  ["GRP-03.update", grp03Update],
  ["GRP-04.archive", grp04Archive],
  ["GRP-04.unarchive", grp04Unarchive],
  ["GRP-05", grp05Suggest],
  ["FEE-01", fee01List],
  ["FEE-02", fee02Create],
  // M3 — CCH-01..05 (coaches and assignments)
  ["CCH-01", cch01List],
  ["CCH-02", cch02List],
  ["CCH-03", cch03Create],
  ["CCH-04", cch04End],
  ["CCH-05", cch05MyGroups],
  // M3 — PLY-01..09 (players); PLY-10 is M4 and sits with them so the player routes read
  // in one place
  ["PLY-01", ply01List],
  ["PLY-02", ply02Create],
  ["PLY-03", ply03Read],
  ["PLY-04", ply04Update],
  ["PLY-05", ply05Status],
  ["PLY-06", ply06Transfer],
  ["PLY-07", ply07GroupHistory],
  ["PLY-08", ply08CheckDuplicates],
  ["PLY-09", ply09Invoices],
  ["PLY-10", ply10Attendance],
  ["PLY-11", ply11Balance],
  // M3 — GDN-01..05 (guardians)
  ["GDN-01", gdn01List],
  ["GDN-02", gdn02Update],
  ["GDN-03", gdn03Link],
  ["GDN-04.update", gdn04Update],
  ["GDN-04.delete", gdn04Delete],
  ["GDN-05", gdn05Consent],
  ["GDN-06", gdn06Balance],
  // M3 — IMP-01/02 (CSV import)
  ["IMP-01", imp01Validate],
  ["IMP-02", imp02Commit],
  // M4 — SCH-01/02 (training schedules and generation)
  ["SCH-01.list", sch01List],
  ["SCH-01.create", sch01Create],
  ["SCH-01.update", sch01Update],
  ["SCH-01.deactivate", sch01Deactivate],
  ["SCH-02", sch02Generate],
  // M4 — SES-01..04 (sessions)
  ["SES-01", ses01List],
  ["SES-02", ses02Create],
  ["SES-03.read", ses03Read],
  ["SES-03.update", ses03Update],
  ["SES-04", ses04Cancel],
  // M4 — ATT-01..03 (the attendance sheet)
  ["ATT-01", att01Read],
  ["ATT-02", att02Save],
  ["ATT-03", att03Correct],
  // M4 — CAT-01..05 (coach time, CR-003)
  ["CAT-01", cat01CheckIn],
  ["CAT-02", cat02CheckOut],
  ["CAT-03", cat03List],
  ["CAT-04", cat04Create],
  ["CAT-05", cat05Correct],
  // M5 — PAY-01..08 (payments, allocations and the money rules)
  ["PAY-01", pay01List],
  ["PAY-02", pay02Create],
  ["PAY-03.read", pay03Read],
  ["PAY-03.update", pay03Update],
  ["PAY-04", pay04Confirm],
  ["PAY-05", pay05Reject],
  ["PAY-06", pay06Allocate],
  ["PAY-07", pay07Reverse],
  ["PAY-08", pay08Suggestion],
  // M5 — BIL-01..03 (the billing runs that issue invoices)
  ["BIL-01", bil01Preview],
  ["BIL-02", bil02Run],
  ["BIL-03.list", bil03List],
  ["BIL-03.read", bil03Read],
  // M5 — INV-01..05 (list, read, manual invoice, void, adjustment)
  ["INV-01", inv01List],
  ["INV-02", inv02Read],
  ["INV-03", inv03Create],
  ["INV-04", inv04Void],
  ["INV-05", inv05Adjust],
  // M6 — INV-06/07 (the invoice PDF: read never renders, regenerate does)
  ["INV-06", inv06Download],
  ["INV-07", inv07Regenerate],
  // M5 — PRF-03/04 (proof deletion and the advisory re-check)
  ["PRF-03", prf03Delete],
  ["PRF-04", prf04Verify],
  // M6 — PRF-01/02 (upload a proof, and the short-lived signed URL that reads it back)
  ["PRF-01", prf01Upload],
  ["PRF-02", prf02Download],
  // M5 — RCT-01 (receipts)
  ["RCT-01", rct01List],
  // M6 — RCT-02 (the receipt PDF: read never renders, regenerate does)
  ["RCT-02.download", rct02Download],
  ["RCT-02.regenerate", rct02Regenerate],
  // M6 — SET-03 (the academy logo)
  ["SET-03", set03UploadLogo],
  // M6 — PUB-01/02 (the two routes with no session: a capability link, and the public logo)
  ["PUB-01", pub01InvoicePdf],
  ["PUB-02", pub02Logo],
  // M8 — DSH-02 (the coach's own dashboard)
  ["DSH-02", dsh02Coach],
  // M8 — DSH-01 (the owner dashboard), RPT-01/02 (reports), AUD-01 (audit trail),
  // SYS-03 (detailed health). SYS-03 is the operator's page: without it, monitoring and
  // the worker's own evidence have no surface at all.
  ["DSH-01", dsh01Owner],
  ["RPT-01", rpt01Run],
  ["RPT-02", rpt02Export],
  ["AUD-01", aud01List],
  ["SYS-03", sys03Health],
]);
