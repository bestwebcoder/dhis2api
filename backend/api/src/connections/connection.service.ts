import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  type AuthUser,
  type ConnectionSummary,
  type ConnectionTestResult,
  type CreateConnectionInput,
  type DeletionResult,
  type UpdateConnectionInput
} from "@dhis-sync/contracts";
import {
  Dhis2Client,
  type Dhis2Credential,
  normalizeDhis2BaseUrl
} from "@dhis-sync/dhis2-client";
import { UserRepository } from "../auth/user.repository.js";
import { AccessScope } from "../common/access-scope.js";
import { AuditService } from "../common/audit.service.js";
import { rejectDanglingReferences, requireConfirmation, summarise } from "../common/deletion.js";
import { SecretCipherService } from "../security/secret-cipher.service.js";
import { ConnectionRepository, type ConnectionDependencies, type StoredConnection } from "./connection.repository.js";

type StoredCredential = Dhis2Credential;

/** Names what is in the way, so the caller knows exactly what to clear first. */
function describeDependencies(dependencies: ConnectionDependencies): string {
  const parts: string[] = [];
  if (dependencies.syncDefinitions.length) parts.push(`sync definition(s) ${dependencies.syncDefinitions.join(", ")}`);
  if (dependencies.blueprints.length) parts.push(`schema blueprint(s) for ${dependencies.blueprints.join(", ")}`);
  return `This connection is still in use by ${parts.join(" and ")}. Delete those first, or deactivate the connection instead of deleting it.`;
}

const NOT_FOUND = "Connection not found";

function publicSummary(connection: StoredConnection): ConnectionSummary {
  const { ciphertext: _ciphertext, iv: _iv, tag: _tag, ...safe } = connection;
  return safe;
}

@Injectable()
export class ConnectionService {
  constructor(
    @Inject(ConnectionRepository) private readonly repository: ConnectionRepository,
    @Inject(SecretCipherService) private readonly cipher: SecretCipherService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UserRepository) private readonly users: UserRepository
  ) {}

  private credentialFromInput(input: CreateConnectionInput): StoredCredential {
    if (input.authType === "pat" && input.apiToken) {
      return { type: "pat", apiToken: input.apiToken.trim() };
    }
    if (input.authType === "basic" && input.username && input.password) {
      return { type: "basic", username: input.username.trim(), password: input.password };
    }
    throw new BadRequestException("Credentials do not match the selected authentication type");
  }

  private client(
    baseUrl: string,
    credential: StoredCredential,
    dhis2Version?: string | null,
    timeoutMs?: number
  ): Dhis2Client {
    return new Dhis2Client({
      baseUrl,
      credential,
      ...(dhis2Version === undefined ? {} : { dhis2Version }),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
  }

  private async runConnectionTest(
    baseUrl: string,
    credential: StoredCredential
  ): Promise<ConnectionTestResult> {
    try {
      return await this.client(baseUrl, credential, undefined, 15_000).testConnection();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection test failed";
      throw new BadRequestException(message);
    }
  }

  async list(scope: AccessScope): Promise<ConnectionSummary[]> {
    return (await this.repository.list(scope.ownerFilter)).map(publicSummary);
  }

  /**
   * Unscoped on purpose: the sync runner opens a connection on behalf of a
   * schedule, where there is no request and no caller. Every request-driven
   * path reaches a connection through a scoped method above.
   */
  async getAuthenticatedClient(id: string): Promise<Dhis2Client> {
    const stored = await this.repository.findById(id);
    if (!stored) throw new NotFoundException(NOT_FOUND);
    const credential = this.cipher.decrypt<StoredCredential>({
      ciphertext: stored.ciphertext,
      iv: stored.iv,
      tag: stored.tag
    });
    return this.client(stored.baseUrl, credential, stored.dhis2Version);
  }

  async getSummary(id: string, scope?: AccessScope): Promise<ConnectionSummary> {
    const stored = await this.repository.findById(id);
    if (!stored) throw new NotFoundException(NOT_FOUND);
    scope?.assertOwns(stored.ownerId, NOT_FOUND);
    return publicSummary(stored);
  }

  async testUnsaved(input: CreateConnectionInput): Promise<ConnectionTestResult> {
    return this.runConnectionTest(input.baseUrl, this.credentialFromInput(input));
  }

  async create(input: CreateConnectionInput, scope: AccessScope): Promise<ConnectionSummary> {
    const existing = await this.repository.findByName(input.name);
    if (existing) {
      throw new ConflictException(
        `A connection named "${existing.name}" already exists. Use its Retest action or choose a different name`
      );
    }
    const credential = this.credentialFromInput(input);
    const normalizedBaseUrl = normalizeDhis2BaseUrl(input.baseUrl);
    const test = input.testBeforeSave
      ? await this.runConnectionTest(normalizedBaseUrl, credential)
      : null;
    let stored: StoredConnection;
    try {
      stored = await this.repository.insert({
        name: input.name.trim(),
        role: input.role,
        baseUrl: normalizedBaseUrl,
        authType: input.authType,
        encryptedSecret: this.cipher.encrypt(credential),
        test,
        createdBy: scope.userId
      });
    } catch (error) {
      const databaseError = error as { code?: string; constraint?: string };
      if (databaseError.code === "23505" && databaseError.constraint === "dhis2_connections_name_unique") {
        throw new ConflictException(
          `A connection named "${input.name.trim()}" already exists. Use its Retest action or choose a different name`
        );
      }
      throw error;
    }
    return publicSummary(stored);
  }

  async update(id: string, input: UpdateConnectionInput, scope: AccessScope): Promise<ConnectionSummary> {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException(NOT_FOUND);
    scope.assertOwns(existing.ownerId, NOT_FOUND);
    const duplicate = await this.repository.findByName(input.name);
    if (duplicate && duplicate.id !== id) throw new ConflictException(`A connection named "${duplicate.name}" already exists`);

    let credential: StoredCredential;
    const supplied = input.authType === "pat"
      ? Boolean(input.apiToken?.trim())
      : Boolean(input.username?.trim() && input.password);
    if (supplied) {
      credential = this.credentialFromInput({ ...input, testBeforeSave: true } as CreateConnectionInput);
    } else {
      if (input.authType !== existing.authType) throw new BadRequestException("Enter new credentials when changing the authentication type");
      credential = this.cipher.decrypt<StoredCredential>({ ciphertext: existing.ciphertext, iv: existing.iv, tag: existing.tag });
    }
    const baseUrl = normalizeDhis2BaseUrl(input.baseUrl);
    const test = input.testAfterSave ? await this.runConnectionTest(baseUrl, credential) : null;
    try {
      return publicSummary(await this.repository.update({
        id, name: input.name.trim(), role: input.role, baseUrl, authType: input.authType,
        encryptedSecret: this.cipher.encrypt(credential), test, isActive: input.isActive
      }));
    } catch (error) {
      const databaseError = error as { code?: string };
      if (databaseError.code === "23505") throw new ConflictException(`A connection named "${input.name.trim()}" already exists`);
      throw error;
    }
  }

  async testSaved(id: string, scope: AccessScope): Promise<ConnectionSummary> {
    const stored = await this.repository.findById(id);
    if (!stored) throw new NotFoundException(NOT_FOUND);
    scope.assertOwns(stored.ownerId, NOT_FOUND);
    const credential = this.cipher.decrypt<StoredCredential>({
      ciphertext: stored.ciphertext,
      iv: stored.iv,
      tag: stored.tag
    });
    try {
      const test = await this.client(stored.baseUrl, credential, stored.dhis2Version, 15_000).testConnection();
      return publicSummary(await this.repository.recordTest(id, test));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection test failed";
      await this.repository.recordFailure(id, message);
      throw new BadRequestException(message);
    }
  }

  /**
   * Refuses while anything still points at the connection, and names what does.
   * Only the metadata snapshots go with it — they are a copy of this server's
   * metadata and mean nothing once the connection is gone.
   */
  async delete(id: string, confirmation: unknown, scope: AccessScope): Promise<DeletionResult> {
    const stored = await this.repository.findById(id);
    if (!stored) throw new NotFoundException(NOT_FOUND);
    scope.assertOwns(stored.ownerId, NOT_FOUND);
    requireConfirmation(confirmation, stored.name, "connection");
    const dependencies = await this.repository.dependencies(id);
    if (dependencies.syncDefinitions.length || dependencies.blueprints.length) {
      throw new ConflictException(describeDependencies(dependencies));
    }
    const snapshots = await this.repository.snapshotCount(id);
    // a blueprint or sync created since the check above would fail the FK here
    const removed = await rejectDanglingReferences("connection", () => this.repository.delete(id));
    if (!removed) throw new NotFoundException(NOT_FOUND);
    await this.audit.record({
      actor: scope.user,
      action: "connection.delete",
      entityType: "connection",
      entityId: id,
      before: { name: stored.name, baseUrl: stored.baseUrl, role: stored.role }
    });
    return { deleted: true, cascaded: summarise({ "metadata snapshots": snapshots }), orphaned: {} };
  }

  /**
   * Hands an endpoint to a client account, or takes it back with null. This is
   * how an admin-provisioned client gets something to work with; it is the only
   * way ownership moves, and it is reserved for administrators.
   */
  async reassignOwner(id: string, ownerId: string | null, actor: AuthUser): Promise<ConnectionSummary> {
    const stored = await this.repository.findById(id);
    if (!stored) throw new NotFoundException(NOT_FOUND);
    if (ownerId) {
      const owner = await this.users.findById(ownerId);
      if (!owner) throw new BadRequestException("That account does not exist.");
      if (!owner.isActive) throw new BadRequestException("That account is deactivated. Restore it before giving it an endpoint.");
    }
    const updated = await this.repository.setOwner(id, ownerId);
    if (!updated) throw new NotFoundException(NOT_FOUND);
    await this.audit.record({
      actor,
      action: "connection.reassign_owner",
      entityType: "connection",
      entityId: id,
      before: { ownerId: stored.ownerId },
      after: { ownerId }
    });
    return publicSummary(updated);
  }
}
