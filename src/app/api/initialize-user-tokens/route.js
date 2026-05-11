import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Utilisateur non authentifié",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const existing = await db
      .select({
        balance: users.balance,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (existing.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Utilisateur introuvable",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          balance: existing[0].balance,
          name: existing[0].name,
          email: existing[0].email,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("❌ Error initializing user tokens:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Erreur lors de l'initialisation des tokens",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
