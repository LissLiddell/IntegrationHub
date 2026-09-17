function required(name: "INTEGRATION_TABLE_NAME" | "DELIVERY_QUEUE_URL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function loadAwsConfig() {
  return {
    tableName: required("INTEGRATION_TABLE_NAME"),
    deliveryQueueUrl: required("DELIVERY_QUEUE_URL")
  };
}
