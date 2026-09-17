import { NextResponse } from "next/server";
import { controlApiConnected, controlApiRequest, jsonFromUpstream } from "@/lib/control-api";
import { sampleDetail } from "@/lib/sample-data";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  if (!controlApiConnected()) return NextResponse.json({ ...sampleDetail(runId), mode: "preview" });
  try {
    const response = await controlApiRequest(`/runs/${encodeURIComponent(runId)}`);
    const body = await jsonFromUpstream(response);
    return NextResponse.json(body, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: { code: "CONTROL_API_UNAVAILABLE", message: "No fue posible consultar el detalle." } },
      { status: 502 }
    );
  }
}
