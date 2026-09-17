import { NextResponse } from "next/server";
import { controlApiConnected, controlApiRequest, jsonFromUpstream } from "@/lib/control-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | { role?: unknown; reason?: unknown; note?: unknown }
    | null;
  const role = typeof body?.role === "string" ? body.role : "";
  if (!controlApiConnected()) {
    return NextResponse.json({ outcome: "CLOSED", runId, mode: "preview" });
  }
  try {
    const response = await controlApiRequest(`/runs/${encodeURIComponent(runId)}/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-integrationhub-role": role },
      body: JSON.stringify({ reason: body?.reason, note: body?.note })
    });
    return NextResponse.json(await jsonFromUpstream(response), { status: response.status });
  } catch {
    return NextResponse.json(
      { error: { code: "CONTROL_API_UNAVAILABLE", message: "No fue posible cerrar el caso." } },
      { status: 502 }
    );
  }
}
