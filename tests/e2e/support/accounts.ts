/**
 * Test accounts and documents created in the throw-away end-to-end database by
 * `prepare-database.ts`. Test data only — never used outside that database.
 */
export type TestAccount = {
  name: string;
  username: string;
  password: string;
  role: "admin" | "staff";
};

export const admin: TestAccount = {
  name: "Test Admin",
  username: "e2e.admin",
  password: "e2e-admin-passphrase",
  role: "admin",
};

export const staff: TestAccount = {
  name: "Test Staff",
  username: "e2e.staff",
  password: "e2e-staff-passphrase",
  role: "staff",
};

/** One lock-out target per browser project, so parallel runs don't interfere. */
export function lockoutTarget(project: string): TestAccount {
  return {
    name: `Lockout ${project}`,
    username: `e2e.lock.${project}`,
    password: "e2e-lockout-passphrase",
    role: "staff",
  };
}

/** One account per browser project for the change-password test. */
export function passwordChanger(project: string): TestAccount {
  return {
    name: `Password ${project}`,
    username: `e2e.pw.${project}`,
    password: "e2e-original-passphrase",
    role: "staff",
  };
}

export const PROJECTS = ["desktop", "mobile"] as const;

/** Customer documents with files in the private test storage folder. */
export const testDocuments = {
  idProof: "01970000-0000-7000-8000-00000000d001",
  photo: "01970000-0000-7000-8000-00000000d002",
} as const;
