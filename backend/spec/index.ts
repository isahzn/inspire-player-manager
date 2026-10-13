/**
 * Contract assembly. Sections mirror API_CONTRACTS §3 subsections, one module each,
 * so review maps 1:1 onto the spec document.
 */
import type { Section } from "./registry.js";
import { authUsersSection } from "./sections/01-auth-users.js";
import { settingsSection } from "./sections/02-settings.js";
import { groupsCoachesSection } from "./sections/03-groups-coaches.js";
import { playersGuardiansSection } from "./sections/04-players-guardians.js";
import { sessionsAttendanceSection } from "./sections/05-sessions-attendance.js";
import { billingPaymentsSection } from "./sections/06-billing-payments.js";
import { messagingSection } from "./sections/07-messaging.js";
import { dashboardReportsAdminSection } from "./sections/08-dashboard-reports-admin.js";

export const sections: Section[] = [
  authUsersSection,
  settingsSection,
  groupsCoachesSection,
  playersGuardiansSection,
  sessionsAttendanceSection,
  billingPaymentsSection,
  messagingSection,
  dashboardReportsAdminSection,
];

/** Every endpoint id in the contract, in document order. */
export const allEndpoints = sections.flatMap((s) => s.endpoints);
