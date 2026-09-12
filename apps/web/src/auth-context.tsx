import { createContext, useContext, type ReactNode } from "react";
import type { AuthUser } from "@dhis-sync/contracts";

const CurrentUserContext = createContext<AuthUser | null>(null);

export function CurrentUserProvider({ user, children }: { user: AuthUser; children: ReactNode }) {
  return <CurrentUserContext.Provider value={user}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): AuthUser {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error("useCurrentUser was used outside a signed-in view");
  return user;
}

/**
 * Mirrors the API's RolesGuard, which reserves every DELETE endpoint plus the
 * manual sync run for admins. The server is the authority — this only keeps the
 * UI from offering an action that would come back as 403.
 */
export function useIsAdmin(): boolean {
  return useCurrentUser().role === "admin";
}

export const ROLE_LABEL: Record<AuthUser["role"], string> = { admin: "Administrator", analyst: "Analyst" };

/** Shown where admin-only controls would otherwise sit. */
export function AdminOnlyNote({ text = "Deleting is reserved for administrators" }: { text?: string }) {
  return <span className="role-note">{text}</span>;
}
