import { PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export const awsDemoScenarios = [
  "shipping-success",
  "shipping-timeout",
  "credential-failure"
] as const;

export type AwsDemoScenario = (typeof awsDemoScenarios)[number];

export function isAwsDemoScenario(value: unknown): value is AwsDemoScenario {
  return typeof value === "string" && awsDemoScenarios.includes(value as AwsDemoScenario);
}

export interface DemoScenarioPreparer {
  prepare(scenario: AwsDemoScenario): Promise<void>;
}

type SecretClient = Pick<SecretsManagerClient, "send">;

export class AwsDemoScenarioPreparer implements DemoScenarioPreparer {
  constructor(
    private readonly client: SecretClient,
    private readonly clientSecretArn: string,
    private readonly validDemoCredential: string
  ) {}

  async prepare(scenario: AwsDemoScenario): Promise<void> {
    const token =
      scenario === "credential-failure"
        ? "integrationhub-intentionally-invalid-demo-credential"
        : this.validDemoCredential;

    await this.client.send(
      new PutSecretValueCommand({
        SecretId: this.clientSecretArn,
        SecretString: JSON.stringify({ token })
      })
    );
  }
}
