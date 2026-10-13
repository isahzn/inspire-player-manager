// Step 1 in-memory mocks. Shapes mirror docs/engineering/MOCK_DATA.md
// (AUTH-03 owner + coach). Replaced by MSW + generated OpenAPI types at M1 exit.
export type Role = "owner" | "coach";

export interface MockMe {
  user: {
    id: string;
    username: string;
    fullName: string;
    role: Role;
    status: "active";
    totpEnabled: boolean;
  };
  csrfToken: string;
  academy: { name: string; timezone: string; logoUrl?: string };
  permissions: string[];
  assignedGroupIds?: string[];
}

export const OWNER_ME: MockMe = {
  user: {
    id: "0192a000-0000-7000-8000-000000000001",
    username: "owner",
    fullName: "Demo Owner",
    role: "owner",
    status: "active",
    totpEnabled: false,
  },
  csrfToken: "mock-csrf-token",
  academy: { name: "Inspire Academy", timezone: "Asia/Colombo" },
  permissions: [
    "users:manage",
    "settings:manage",
    "players:manage",
    "billing:manage",
    "payments:manage",
    "messaging:manage",
    "reports:read",
    "audit:read",
    // Step 4 needed the training-side strings too: the guards read
    // Me.permissions, never a hard-coded role, so an owner without these could
    // not open the sessions or coach-time screens. Mirrored in MOCK_DATA.md.
    "sessions:read",
    "sessions:manage",
    "attendance:mark",
    "attendance:correct_any",
    "coach_attendance:manage",
  ],
};

export const COACH_ME: MockMe = {
  user: {
    id: "0192a000-0000-7000-8000-000000000002",
    username: "coach",
    fullName: "Demo Coach",
    role: "coach",
    status: "active",
    totpEnabled: false,
  },
  csrfToken: "mock-csrf-token",
  academy: { name: "Inspire Academy", timezone: "Asia/Colombo" },
  permissions: [
    "groups:read",
    "players:read_restricted",
    "sessions:read",
    "attendance:mark",
    "coach_attendance:self",
  ],
  assignedGroupIds: ["0192a000-0000-7000-8000-0000000000a1"],
};
