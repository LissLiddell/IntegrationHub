import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  type SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeliveryFailure, DeliveryResult, WebhookEvent } from "../domain/model.ts";
import type { ConnectionCredentialStore, HttpDelivery } from "../domain/ports.ts";
import { keys } from "./dynamo-keys.ts";

export interface Connection {
  id: string;
  organizationId: string;
  endpointUrl: string;
  timeoutMs: number;
  secretArn?: string;
  verificationUrl?: string;
}

export interface ConnectionProvider {
  getConnection(organizationId: string, connectionId: string): Promise<Connection | null>;
}

export interface SecretProvider {
  getToken(secretArn: string): Promise<string>;
}

export interface AddressResolver {
  resolve(hostname: string): Promise<string[]>;
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type DocumentClient = Pick<DynamoDBDocumentClient, "send">;
type SecretClient = Pick<SecretsManagerClient, "send">;

export class DynamoConnectionProvider implements ConnectionProvider {
  constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string
  ) {}

  async getConnection(organizationId: string, connectionId: string): Promise<Connection | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: keys.organization(organizationId), SK: keys.connection(connectionId) },
        ConsistentRead: true
      })
    );
    const item = response.Item;
    if (!item) return null;
    if (
      item.entityType !== "CONNECTION" ||
      typeof item.id !== "string" ||
      typeof item.organizationId !== "string" ||
      typeof item.endpointUrl !== "string" ||
      typeof item.timeoutMs !== "number"
    ) {
      throw new Error("DynamoDB connection item is invalid.");
    }
    return {
      id: item.id,
      organizationId: item.organizationId,
      endpointUrl: item.endpointUrl,
      timeoutMs: item.timeoutMs,
      ...(typeof item.secretArn === "string" ? { secretArn: item.secretArn } : {}),
      ...(typeof item.verificationUrl === "string" ? { verificationUrl: item.verificationUrl } : {})
    };
  }
}

export class AwsSecretProvider implements SecretProvider {
  constructor(private readonly client: SecretClient) {}

  async getToken(secretArn: string): Promise<string> {
    const response = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const secret = response.SecretString;
    if (!secret) throw new Error("Secret has no string value.");
    try {
      const parsed: unknown = JSON.parse(secret);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "token" in parsed &&
        typeof parsed.token === "string" &&
        parsed.token
      ) {
        return parsed.token;
      }
    } catch {
      // Plain strings are supported too.
    }
    return secret;
  }
}

export class AwsConnectionCredentialStore implements ConnectionCredentialStore {
  private readonly connections: DynamoConnectionProvider;

  constructor(
    documentClient: DocumentClient,
    tableName: string,
    private readonly client: SecretClient,
    private readonly resolver: AddressResolver = systemAddressResolver,
    private readonly fetcher: Fetcher = fetch
  ) {
    this.connections = new DynamoConnectionProvider(documentClient, tableName);
  }

  async replaceCredentialAndVerify(
    organizationId: string,
    connectionId: string,
    credential: string
  ): Promise<
    | { verified: true }
    | {
        verified: false;
        code: "UNSAFE_DESTINATION" | "REJECTED" | "UNAVAILABLE" | "ROLLBACK_FAILED";
      }
  > {
    const connection = await this.connections.getConnection(organizationId, connectionId);
    if (!connection) throw new Error("Connection was not found.");
    if (!connection.secretArn) throw new Error("Connection does not have a managed credential.");
    if (!connection.verificationUrl) throw new Error("Connection does not have a verification URL.");

    let verificationUrl: URL;
    try {
      verificationUrl = await validateDestination(connection.verificationUrl, this.resolver);
    } catch {
      return { verified: false, code: "UNSAFE_DESTINATION" };
    }

    let previousSecret: string;
    try {
      const previous = await this.client.send(
        new GetSecretValueCommand({ SecretId: connection.secretArn })
      );
      if (!previous.SecretString) return { verified: false, code: "UNAVAILABLE" };
      previousSecret = previous.SecretString;
      await this.client.send(
        new PutSecretValueCommand({
          SecretId: connection.secretArn,
          SecretString: JSON.stringify({ token: credential })
        })
      );
    } catch {
      return { verified: false, code: "UNAVAILABLE" };
    }

    let failureCode: "REJECTED" | "UNAVAILABLE" | undefined;
    try {
      const response = await this.fetcher(verificationUrl.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(Math.max(connection.timeoutMs, 500), 30_000)),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`
        }
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return { verified: true };
      failureCode = response.status === 401 || response.status === 403 ? "REJECTED" : "UNAVAILABLE";
    } catch {
      failureCode = "UNAVAILABLE";
    }

    try {
      await this.client.send(
        new PutSecretValueCommand({
          SecretId: connection.secretArn,
          SecretString: previousSecret
        })
      );
    } catch {
      return { verified: false, code: "ROLLBACK_FAILED" };
    }
    return { verified: false, code: failureCode ?? "UNAVAILABLE" };
  }
}

export const systemAddressResolver: AddressResolver = {
  async resolve(hostname) {
    return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
  }
};

function isBlockedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version !== 6) return true;

  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

export async function validateDestination(rawUrl: string, resolver: AddressResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Destination URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Destination must be an HTTPS URL without embedded credentials.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Destination hostname is not public.");
  }
  const addresses = isIP(hostname) ? [hostname] : await resolver.resolve(hostname);
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new Error("Destination resolves to a blocked network address.");
  }
  return url;
}

async function readResponsePreview(response: Response, limit = 4_096): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, limit);
}

export class SecureHttpDelivery implements HttpDelivery {
  constructor(
    private readonly connections: ConnectionProvider,
    private readonly secrets: SecretProvider,
    private readonly resolver: AddressResolver = systemAddressResolver,
    private readonly fetcher: Fetcher = fetch
  ) {}

  async deliver(input: {
    organizationId: string;
    connectionId: string;
    correlationId: string;
    event: WebhookEvent;
  }): Promise<DeliveryResult | DeliveryFailure> {
    const connection = await this.connections.getConnection(input.organizationId, input.connectionId);
    if (!connection) {
      return {
        code: "CONNECTION_NOT_FOUND",
        message: "The configured HTTP connection no longer exists.",
        retryable: false
      };
    }

    let destination: URL;
    try {
      destination = await validateDestination(connection.endpointUrl, this.resolver);
    } catch (error) {
      return {
        code: "UNSAFE_DESTINATION",
        message: error instanceof Error ? error.message : "Destination is not allowed.",
        retryable: false
      };
    }

    let token: string | undefined;
    if (connection.secretArn) {
      try {
        token = await this.secrets.getToken(connection.secretArn);
      } catch {
        return {
          code: "SECRET_UNAVAILABLE",
          message: "The destination credential could not be loaded.",
          retryable: true
        };
      }
    }

    try {
      const response = await this.fetcher(destination.toString(), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(Math.max(connection.timeoutMs, 500), 30_000)),
        headers: {
          "content-type": "application/json",
          "x-integrationhub-correlation-id": input.correlationId,
          "x-integrationhub-event-id": input.event.eventId,
          "x-integrationhub-event-type": input.event.eventType,
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(input.event.payload)
      });
      return { httpStatus: response.status, responseBody: await readResponsePreview(response) };
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        message: timedOut ? "Destination timed out." : "Destination could not be reached.",
        retryable: true
      };
    }
  }
}
