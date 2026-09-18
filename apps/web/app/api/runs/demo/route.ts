import { NextResponse } from "next/server";
import { controlApiConnected, controlApiRequest, jsonFromUpstream } from "@/lib/control-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { role?: unknown };
  const role = typeof body.role === "string" ? body.role : "";
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
      body: JSON.stringify({ scenario: "shipping-timeout" })
    });
    return NextResponse.json(await jsonFromUpstream(response), { status: response.status });
  } catch {
    return NextResponse.json(
      { error: { code: "CONTROL_API_UNAVAILABLE", message: "No fue posible generar la prueba AWS." } },
      { status: 502 }
    );
  }
}
