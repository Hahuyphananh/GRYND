import { auth } from "@clerk/nextjs/server";
import { parseAndValidateJson } from "../../../lib/security/validation";

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Utilisateur non authentifié" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const parsed = await parseAndValidateJson(request, {
      search: { type: "string", required: true, minLength: 2, maxLength: 80 },
    });

    if (!parsed.ok) return parsed.response;

    const response = await fetch(
      `https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${encodeURIComponent(parsed.data.search)}`,
    );

    if (!response.ok) {
      return new Response(JSON.stringify({ error: "Erreur API distante" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await response.json();

    return new Response(JSON.stringify({ players: data.player || [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Error searching player:", err);
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
