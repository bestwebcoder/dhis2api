import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type {
  Dhis2ResourceSummary,
  DiscoverMetadataInput,
  ResourceType
} from "@dhis-sync/contracts";
import type { AccessScope } from "../common/access-scope.js";
import { ConnectionService } from "../connections/connection.service.js";
import { MetadataRepository, type StoredMetadataSnapshot } from "./metadata.repository.js";

@Injectable()
export class MetadataService {
  constructor(
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(MetadataRepository) private readonly repository: MetadataRepository
  ) {}

  private async withFriendlyError<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : "DHIS2 metadata request failed";
      throw new BadRequestException(message);
    }
  }

  async listResources(connectionId: string, resourceType: ResourceType, scope: AccessScope): Promise<Dhis2ResourceSummary[]> {
    // browsing a DHIS2 server's metadata requires owning the endpoint it belongs to
    await this.connections.getSummary(connectionId, scope);
    return this.withFriendlyError(async () => {
      const client = await this.connections.getAuthenticatedClient(connectionId);
      return resourceType === "program" ? client.listPrograms() : client.listDataSets();
    });
  }

  async discover(input: DiscoverMetadataInput, scope: AccessScope): Promise<StoredMetadataSnapshot> {
    const connection = await this.connections.getSummary(input.connectionId, scope);
    return this.withFriendlyError(async () => {
      const client = await this.connections.getAuthenticatedClient(input.connectionId);
      const metadata = input.resourceType === "program"
        ? await client.getProgram(input.resourceUid)
        : await client.getDataSet(input.resourceUid);
      const resourceName = String(metadata.displayName ?? metadata.name ?? input.resourceUid);
      const metadataHash = createHash("sha256")
        .update(JSON.stringify(metadata))
        .digest("hex");
      return this.repository.save({
        connectionId: input.connectionId,
        resourceType: input.resourceType,
        resourceUid: input.resourceUid,
        resourceName,
        dhis2Version: connection.dhis2Version,
        metadataHash,
        metadata
      });
    });
  }
}

