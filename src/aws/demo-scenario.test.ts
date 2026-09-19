import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { AwsDemoScenarioPreparer } from "./demo-scenario.ts";

describe("AWS demo scenario preparation", () => {
  it("switches only the IntegrationHub client credential for each controlled scenario", async () => {
    const commands: PutSecretValueCommand[] = [];
    const client = {
      async send(command: PutSecretValueCommand) {
        commands.push(command);
        return {};
      }
    };
    const preparer = new AwsDemoScenarioPreparer(
      client as never,
      "arn:aws:secretsmanager:us-east-1:123:secret:integrationhub/client",
      "nebula-portfolio-demo-2026"
    );

    await preparer.prepare("credential-failure");
    await preparer.prepare("shipping-success");

    assert.deepEqual(
      commands.map((command) => ({
        secretId: command.input.SecretId,
        secret: JSON.parse(command.input.SecretString ?? "{}")
      })),
      [
        {
          secretId: "arn:aws:secretsmanager:us-east-1:123:secret:integrationhub/client",
          secret: { token: "integrationhub-intentionally-invalid-demo-credential" }
        },
        {
          secretId: "arn:aws:secretsmanager:us-east-1:123:secret:integrationhub/client",
          secret: { token: "nebula-portfolio-demo-2026" }
        }
      ]
    );
  });
});
