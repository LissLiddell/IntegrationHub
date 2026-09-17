import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  AwsConnectionCredentialStore,
  isBlockedAddress,
  SecureHttpDelivery,
  validateDestination,
  type AddressResolver,
  type ConnectionProvider,
  type SecretProvider
} from "./secure-http-delivery.ts";

const publicResolver: AddressResolver = {
  resolve: async () => ["203.0.113.10"]
};

const noSecrets: SecretProvider = {
  getToken: async () => {
    throw new Error("No secret expected");
  }
};

function connectionProvider(overrides: Partial<Awaited<ReturnType<ConnectionProvider["getConnection"]>>> = {}) {
  return {
    getConnection: async () => ({
      id: "connection_fulfillment",
      organizationId: "org_nebula",
      endpointUrl: "https://hooks.example.test/orders",
      timeoutMs: 5_000,
      ...overrides
    })
  } satisfies ConnectionProvider;
}

const deliveryInput = {
  organizationId: "org_nebula",
  connectionId: "connection_fulfillment",
  correlationId: "correlation_001",
  event: {
    eventId: "evt_001",
    eventType: "order.created",
    payload: { orderId: "ORD-001" }
  }
};

describe("secure HTTP delivery", () => {
  it("rotates and verifies a managed credential without executing the business request", async () => {
    const sentSecretCommands: unknown[] = [];
    let capturedUrl = "";
    let capturedAuthorization = "";
    const store = new AwsConnectionCredentialStore(
      {
        send: async () => ({
          Item: {
            entityType: "CONNECTION",
            id: "connection_fulfillment",
            organizationId: "org_nebula",
            endpointUrl: "https://hooks.example.test/orders",
            verificationUrl: "https://hooks.example.test/orders/verify",
            timeoutMs: 5_000,
            secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:nebula"
          }
        })
      } as never,
      "IntegrationTable",
      {
        send: async (command: unknown) => {
          sentSecretCommands.push(command);
          if (command instanceof GetSecretValueCommand) {
            return { SecretString: JSON.stringify({ token: "previous-token" }) };
          }
          return {};
        }
      } as never,
      publicResolver,
      async (url, init) => {
        capturedUrl = url;
        capturedAuthorization = (init.headers as Record<string, string>).authorization ?? "";
        return new Response(null, { status: 200 });
      }
    );

    const result = await store.replaceCredentialAndVerify(
      "org_nebula",
      "connection_fulfillment",
      "replacement-token"
    );

    assert.deepEqual(result, { verified: true });
    assert.equal(capturedUrl, "https://hooks.example.test/orders/verify");
    assert.equal(capturedAuthorization, "Bearer replacement-token");
    assert.equal(sentSecretCommands.length, 2);
    assert.ok(sentSecretCommands[1] instanceof PutSecretValueCommand);
    const input = (sentSecretCommands[1] as PutSecretValueCommand).input;
    assert.deepEqual(input, {
      SecretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:nebula",
      SecretString: JSON.stringify({ token: "replacement-token" })
    });
  });

  it("restores the previous credential when the safe verification is rejected", async () => {
    const sentSecretCommands: unknown[] = [];
    const previousSecret = JSON.stringify({ token: "previous-token" });
    const store = new AwsConnectionCredentialStore(
      {
        send: async () => ({
          Item: {
            entityType: "CONNECTION",
            id: "connection_fulfillment",
            organizationId: "org_nebula",
            endpointUrl: "https://hooks.example.test/orders",
            verificationUrl: "https://hooks.example.test/orders/verify",
            timeoutMs: 5_000,
            secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:nebula"
          }
        })
      } as never,
      "IntegrationTable",
      {
        send: async (command: unknown) => {
          sentSecretCommands.push(command);
          return command instanceof GetSecretValueCommand ? { SecretString: previousSecret } : {};
        }
      } as never,
      publicResolver,
      async () => new Response(null, { status: 401 })
    );

    const result = await store.replaceCredentialAndVerify(
      "org_nebula",
      "connection_fulfillment",
      "rejected-token"
    );

    assert.deepEqual(result, { verified: false, code: "REJECTED" });
    assert.equal(sentSecretCommands.length, 3);
    assert.equal(
      (sentSecretCommands[2] as PutSecretValueCommand).input.SecretString,
      previousSecret
    );
  });

  it("blocks loopback, private, metadata, link-local, and multicast addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.2", "169.254.169.254", "::1", "fd00::1", "fe80::1", "ff02::1"]) {
      assert.equal(isBlockedAddress(address), true, address);
    }
    assert.equal(isBlockedAddress("8.8.8.8"), false);
    assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
  });

  it("requires HTTPS and rejects hostnames resolving to private networks", async () => {
    await assert.rejects(validateDestination("http://example.test", publicResolver), /HTTPS/);
    await assert.rejects(
      validateDestination("https://destination.example.test", { resolve: async () => ["10.0.0.8"] }),
      /blocked network/
    );
  });

  it("loads the secret only for the Authorization header and returns a bounded response", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const delivery = new SecureHttpDelivery(
      connectionProvider({ secretArn: "arn:aws:secretsmanager:demo" }),
      { getToken: async () => "super-secret-token" },
      publicResolver,
      async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response("accepted", { status: 202 });
      }
    );

    const result = await delivery.deliver(deliveryInput);

    assert.deepEqual(result, { httpStatus: 202, responseBody: "accepted" });
    assert.equal(capturedUrl, "https://hooks.example.test/orders");
    assert.equal((capturedInit?.headers as Record<string, string>).authorization, "Bearer super-secret-token");
    assert.equal(JSON.stringify(result).includes("super-secret-token"), false);
  });

  it("rejects an unsafe destination before making any network request", async () => {
    let fetchCalls = 0;
    const delivery = new SecureHttpDelivery(
      connectionProvider(),
      noSecrets,
      { resolve: async () => ["169.254.169.254"] },
      async () => {
        fetchCalls += 1;
        return new Response(null, { status: 204 });
      }
    );

    const result = await delivery.deliver(deliveryInput);

    assert.deepEqual(result, {
      code: "UNSAFE_DESTINATION",
      message: "Destination resolves to a blocked network address.",
      retryable: false
    });
    assert.equal(fetchCalls, 0);
  });

  it("classifies timeouts as retryable without exposing the thrown error", async () => {
    const delivery = new SecureHttpDelivery(connectionProvider(), noSecrets, publicResolver, async () => {
      const error = new Error("socket details that must not leak");
      error.name = "TimeoutError";
      throw error;
    });

    assert.deepEqual(await delivery.deliver(deliveryInput), {
      code: "TIMEOUT",
      message: "Destination timed out.",
      retryable: true
    });
  });
});
