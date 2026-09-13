import type {
  AuthSession,
  AuthUser,
  BackupAvailability,
  ConnectionSummary,
  ConnectionTestResult,
  CreateUserInput,
  CreateConnectionInput,
  CreateSyncDefinitionInput,
  DashboardView,
  DeletionResult,
  Dhis2ResourceSummary,
  GenerateBlueprintInput,
  ReportDefinitionSummary,
  RunHistoryClearResult,
  ReportPage,
  TableDropResult,
  ResourceType,
  SchemaBlueprintSummary,
  SignInInput,
  SignUpInput,
  SyncDefinitionSummary,
  ChangePasswordInput,
  UpdateBlueprintInput,
  UpdateConnectionInput,
  UpdateSyncDefinitionInput,
  UpdateProfileInput,
  UpdateUserInput,
  UserSummary,
  UpsertScheduleInput
} from "@dhis-sync/contracts";
import { notifySessionExpired, readToken } from "./session-token.js";

export const API_URL = (import.meta.env.VITE_API_URL?.trim() || "http://localhost:4000/api/v1").replace(/\/+$/, "");

function connectionPayload(input: CreateConnectionInput): CreateConnectionInput {
  const common = {
    name: input.name,
    role: input.role,
    baseUrl: input.baseUrl,
    authType: input.authType,
    testBeforeSave: input.testBeforeSave
  };
  return input.authType === "pat"
    ? { ...common, authType: "pat", apiToken: input.apiToken }
    : { ...common, authType: "basic", username: input.username, password: input.password };
}

function authorized(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  const token = readToken();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = authorized(init);
  if (init?.body !== undefined && !headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers
    });
  } catch (cause) {
    if (cause instanceof TypeError) {
      throw new Error(`Cannot reach the API at ${API_URL}. Check that the API is running and allows requests from this website.`);
    }
    throw cause;
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    // an expired or revoked token must drop the whole app back to signed-out,
    // not surface as a per-page error the user cannot act on
    if (response.status === 401 && !path.startsWith("/auth/")) notifySessionExpired();
    const candidate = payload as { message?: string | string[] } | null;
    const message = Array.isArray(candidate?.message)
      ? candidate.message.join(", ")
      : candidate?.message ?? `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function download(path: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { headers: authorized() });
  } catch (cause) {
    if (cause instanceof TypeError) throw new Error(`Cannot reach the API at ${API_URL}. Check that the API is running and allows requests from this website.`);
    throw cause;
  }
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired();
    const payload = await response.json().catch(() => null) as { message?: string | string[] } | null;
    const message = Array.isArray(payload?.message) ? payload.message.join(", ") : payload?.message;
    throw new Error(message ?? `Download failed with HTTP ${response.status}`);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? "dhis2-backup";
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  return filename;
}

export const connectionApi = {
  list: () => request<ConnectionSummary[]>("/connections"),
  test: (input: CreateConnectionInput) => request<ConnectionTestResult>("/connections/test", {
    method: "POST",
    body: JSON.stringify(connectionPayload(input))
  }),
  create: (input: CreateConnectionInput) => request<ConnectionSummary>("/connections", {
    method: "POST",
    body: JSON.stringify(connectionPayload(input))
  }),
  update: (id: string, input: UpdateConnectionInput) => request<ConnectionSummary>(`/connections/${id}`, {
    method: "PUT", body: JSON.stringify(input)
  }),
  testSaved: (id: string) => request<ConnectionSummary>(`/connections/${id}/test`, { method: "POST" }),
  // admin only: hand an endpoint to a client account, or take it back with null
  setOwner: (id: string, ownerId: string | null) => request<ConnectionSummary>(`/connections/${id}/owner`, {
    method: "PUT", body: JSON.stringify({ ownerId })
  }),
  delete: (id: string, name: string) => request<DeletionResult>(`/connections/${id}?confirm=${encodeURIComponent(name)}`, { method: "DELETE" })
};

export const schemaApi = {
  resources: (connectionId: string, type: ResourceType) =>
    request<Dhis2ResourceSummary[]>(`/metadata/connections/${connectionId}/resources?type=${type}`),
  list: () => request<SchemaBlueprintSummary[]>("/schema-blueprints"),
  generate: (input: GenerateBlueprintInput) => request<SchemaBlueprintSummary>("/schema-blueprints", {
    method: "POST", body: JSON.stringify(input)
  }),
  update: (id: string, input: UpdateBlueprintInput) => request<SchemaBlueprintSummary>(`/schema-blueprints/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  apply: (id: string) => request<SchemaBlueprintSummary>(`/schema-blueprints/${id}/apply`, { method: "POST" }),
  drop: (id: string, tableName: string, cascade = false) => request<TableDropResult>(`/schema-blueprints/${id}/table?confirm=${encodeURIComponent(tableName)}&cascade=${cascade}`, { method: "DELETE" }),
  deleteBlueprint: (id: string, tableName: string) => request<DeletionResult>(`/schema-blueprints/${id}/blueprint?confirm=${encodeURIComponent(tableName)}`, { method: "DELETE" })
};

export const syncApi = {
  list: () => request<SyncDefinitionSummary[]>("/sync-definitions"),
  create: (input: CreateSyncDefinitionInput) => request<SyncDefinitionSummary>("/sync-definitions", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, input: UpdateSyncDefinitionInput) => request<SyncDefinitionSummary>(`/sync-definitions/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  run: (id: string) => request<SyncDefinitionSummary>(`/sync-definitions/${id}/run`, { method: "POST" }),
  schedule: (id: string, input: UpsertScheduleInput) => request<SyncDefinitionSummary>(`/sync-definitions/${id}/schedule`, { method: "PUT", body: JSON.stringify(input) }),
  deleteSchedule: (id: string) => request<{ deleted: true }>(`/sync-definitions/${id}/schedule`, { method: "DELETE" }),
  clearRuns: (id: string) => request<RunHistoryClearResult>(`/sync-definitions/${id}/runs`, { method: "DELETE" }),
  delete: (id: string, name: string) => request<DeletionResult>(`/sync-definitions/${id}?confirm=${encodeURIComponent(name)}`, { method: "DELETE" })
};

export const reportApi = {
  list: () => request<ReportDefinitionSummary[]>("/reports"),
  data: (id: string, parameters: URLSearchParams) => request<ReportPage>(`/reports/${id}/data?${parameters.toString()}`),
  downloadCsv: (id: string, parameters: URLSearchParams) => download(`/reports/${id}/export.csv?${parameters.toString()}`)
};

export const authApi = {
  register: (input: SignUpInput) => request<AuthSession>("/auth/register", { method: "POST", body: JSON.stringify(input) }),
  login: (input: SignInInput) => request<AuthSession>("/auth/login", { method: "POST", body: JSON.stringify(input) }),
  me: () => request<AuthUser>("/auth/me")
};

export const backupApi = {
  years: (id: string) => request<BackupAvailability>(`/backups/${id}/years`),
  download: (id: string, format: "json" | "csv", year: string) =>
    download(`/backups/${id}/data.${format}?year=${encodeURIComponent(year || "all")}`)
};

/** The caller's own dashboard. One route; the API decides what it contains. */
export const dashboardApi = {
  view: () => request<DashboardView>("/dashboard")
};

export const userApi = {
  /** The signed-in account's own profile; the API never returns anyone else's here. */
  readOwnProfile: () => request<UserSummary>("/users/me/profile"),
  list: () => request<UserSummary[]>("/users"),
  create: (input: CreateUserInput) => request<UserSummary>("/users", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, input: UpdateUserInput) => request<UserSummary>(`/users/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  delete: (id: string, email: string) => request<DeletionResult>(`/users/${id}?confirm=${encodeURIComponent(email)}`, { method: "DELETE" }),
  updateOwnProfile: (input: UpdateProfileInput) => request<UserSummary>("/users/me/profile", { method: "PUT", body: JSON.stringify(input) }),
  changeOwnPassword: (input: ChangePasswordInput) => request<{ updated: true }>("/users/me/password", {
    method: "POST", body: JSON.stringify(input)
  })
};
