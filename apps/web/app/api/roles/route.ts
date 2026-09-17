import { NextResponse } from "next/server";
import { controlApiConnected, controlApiRequest, jsonFromUpstream } from "@/lib/control-api";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!controlApiConnected()) {
    return NextResponse.json({
      assignment: {
        actorId: "user_lisset",
        organizationId: "org_nebula",
        displayName: "Lisset López",
        roles: ["operator", "admin", "auditor"],
        updatedAt: "2026-09-11T12:00:00.000Z"
      },
      mode: "preview"
    });
  }
  try {
    const response = await controlApiRequest("/roles");
    const body = await jsonFromUpstream(response);
    return NextResponse.json(
      typeof body === "object" && body !== null ? { ...body, mode: "connected" } : body,
      { status: response.status }
    );
  } catch {
    return NextResponse.json(
      { error: { code: "CONTROL_API_UNAVAILABLE", message: "No fue posible consultar los roles." } },
      { status: 502 }
    );
  }
}
