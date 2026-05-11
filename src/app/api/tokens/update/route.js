import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error:
          "Direct token updates are disabled. Use game-specific endpoints.",
      },
      { status: 403 },
    );
  } catch (err) {
    console.error("Erreur dans /api/tokens/update:", err);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
