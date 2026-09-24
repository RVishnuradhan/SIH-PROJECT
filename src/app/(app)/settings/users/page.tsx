import type { Metadata } from "next";

import { getDb } from "@/lib/db";
import { requirePermission } from "@/modules/auth/session";
import { listUsers } from "@/modules/users/service";

import { CreateUserForm, UserCard } from "./user-forms";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const admin = await requirePermission("user.manage");
  const users = await listUsers(getDb());
  const activeAdmins = users.filter((user) => user.role === "admin" && user.active).length;

  return (
    <div className="space-y-10">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Users</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Create accounts for staff and admins, change roles, reset passwords, and deactivate people
          who no longer need access. Deactivating someone signs them out everywhere at once. Every
          change is recorded in the audit log.
        </p>
      </div>

      <section aria-labelledby="add-user" className="rounded-2xl border bg-card p-6 shadow-sm">
        <h2 id="add-user" className="text-lg font-semibold tracking-tight">
          Add a user
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Staff can bill, process returns, record payments and manage customers. Admins can also
          change rates and stock, void bills and returns, open ID documents and manage users.
        </p>
        <CreateUserForm className="mt-6" />
      </section>

      <section aria-labelledby="all-users" className="space-y-4">
        <h2 id="all-users" className="text-lg font-semibold tracking-tight">
          All users ({users.length})
        </h2>
        <ul className="space-y-3">
          {users.map((user) => (
            <li key={user.id}>
              <UserCard
                user={{ ...user, createdAt: user.createdAt.toISOString() }}
                isSelf={user.id === admin.id}
                isLastActiveAdmin={user.role === "admin" && user.active && activeAdmins === 1}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
