import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const region = process.env.AWS_REGION ?? "us-east-1";
const endpoint = process.env.AWS_ENDPOINT_URL?.trim();
const clientConfig = {
  region,
  ...(endpoint
    ? {
        endpoint,
        credentials: { accessKeyId: "local", secretAccessKey: "local" }
      }
    : {})
};

export const dynamoDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
  marshallOptions: { removeUndefinedValues: true }
});
export const sqsClient = new SQSClient(clientConfig);
export const secretsManagerClient = new SecretsManagerClient(clientConfig);
