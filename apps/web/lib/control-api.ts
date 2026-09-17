import "server-only";

function config() {
  const baseUrl = process.env.INTEGRATIONHUB_API_URL?.trim().replace(/\/$/, "");
  const demoKey = process.env.INTEGRATIONHUB_DEMO_KEY?.trim();
  return baseUrl && demoKey ? { baseUrl, demoKey } : null;
}

export function controlApiConnected(): boolean {
  return config() !== null;
}

export async function controlApiRequest(path: string, init?: RequestInit): Promise<Response> {
  const current = config();
  if (!current) throw new Error("IntegrationHub control API is not configured.");
  return fetch(`${current.baseUrl}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: "application/json",
      "x-integrationhub-demo-key": current.demoKey,
      ...init?.headers
    }
  });
}

export async function jsonFromUpstream(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { error: { code: "UPSTREAM_ERROR", message: "IntegrationHub returned an invalid response." } };
  }
  return body;
}
