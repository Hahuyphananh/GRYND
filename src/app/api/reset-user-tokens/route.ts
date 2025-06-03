import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const { userId } = await auth(); // Added await here

    if (!userId) {
      return NextResponse.json(
        { error: "Non autorisé" }, 
        { status: 401 }
      );
    }

    const result = await sql`
      UPDATE users
      SET balance = 1000.00
      WHERE clerk_id = ${userId}
      RETURNING balance
    `;

    if (result.rowCount === 0) {
      return NextResponse.json(
        { error: "Utilisateur non trouvé" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { 
        success: true,
        balance: result.rows[0].balance
      },
      { status: 200 }
    );

  } catch (error) {
    console.error("Erreur dans reset-user-token:", error);
    return NextResponse.json(
      { 
        error: "Erreur interne du serveur",
        details: error instanceof Error ? error.message : 'Erreur inconnue'
      },
      { status: 500 }
    );
  }
}