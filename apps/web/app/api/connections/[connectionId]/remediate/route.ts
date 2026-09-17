import { NextResponse } from "next/server";
import { controlApiConnected, controlApiRequest, jsonFromUpstream } from "@/lib/control-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | { role?: unknown; runId?: unknown; credential?: unknown }
    | null;
  const role = typeof body?.role === "string" ? body.role : "";
  if (!controlApiConnected()) {
    return NextResponse.json({ outcome: "REMEDIATED", connectionId, runId: body?.runId, mode: "preview" });
  }
  try {
    const response = await controlApiRequest(`/connections/${encodeURIComponent(connectionId)}/remediate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-integrationhub-role": role },
      body: JSON.stringify({ runId: body?.runId, credential: body?.credential })
    });
    return NextResponse.json(await jsonFromUpstream(response), { status: response.status });
  } catch {
    return NextResponse.json(
      { error: { code: "CONTROL_API_UNAVAILABLE", message: "No fue posible corregir la conexión." } },
      { status: 502 }
    );
  }
}
