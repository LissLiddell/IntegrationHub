import { NextResponse } from "next/server";
import { controlApiConnected, controlApiRequest, jsonFromUpstream } from "@/lib/control-api";
import type { AwsDemoScenario } from "@/lib/types";

export const dynamic = "force-dynamic";

const supportedScenarios = new Set<AwsDemoScenario>([
  "shipping-success",
  "shipping-timeout",
  "credential-failure"
]);

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { role?: unknown; scenario?: unknown };
  const role = typeof body.role === "string" ? body.role : "";
  const scenario = typeof body.scenario === "string" ? body.scenario : "";
  if (!supportedScenarios.has(scenario as AwsDemoScenario)) {
    return NextResponse.json(
      { error: { code: "INVALID_DEMO_SCENARIO", message: "Selecciona un escenario AWS válido." } },
      { status: 400 }
    );
  }
  if (!controlApiConnected()) {
    return NextResponse.json(
      { error: { code: "AWS_DEMO_UNAVAILABLE", message: "La demostración AWS no está conectada." } },
      { status: 503 }
    );
  }

  try {
    const response = await controlApiRequest("/runs/demo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-integrationhub-role": role },
      body: JSON.stringify({ scenario })
    });
    return NextResponse.json(await jsonFromUpstream(response), { status: response.status });
  } catch {
    return NextResponse.json(
      { error: { code: "CONTROL_API_UNAVAILABLE", message: "No fue posible generar la prueba AWS." } },
      { status: 502 }
    );
  }
}
