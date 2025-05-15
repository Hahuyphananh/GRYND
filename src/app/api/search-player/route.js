import { auth } from "@clerk/nextjs/server";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Utilisateur non authentifié" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { search } = await request.json();

    if (!search || typeof search !== "string") {
      return new Response(JSON.stringify({ error: "Champ de recherche invalide" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const response = await fetch(
      `https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${encodeURIComponent(search)}`
    );

    if (!response.ok) {
      return new Response(JSON.stringify({ error: "Erreur API distante" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await response.json();

    if (!data.player || !data.player[0]) {
      return new Response(JSON.stringify({ player: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const player = data.player[0];

    return new Response(JSON.stringify({
      id: player.idPlayer,
      name: player.strPlayer,
      team: player.strTeam,
      nationality: player.strNationality,
      position: player.strPosition,
      height: player.strHeight,
      weight: player.strWeight,
      birthdate: player.dateBorn,
      description: player.strDescriptionEN,
      thumb: player.strThumb,
      facebook: player.strFacebook,
      twitter: player.strTwitter,
      instagram: player.strInstagram,
    }), {
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
