async function handler({ search }) {
  try {
    const response = await fetch(
      `https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${search}`
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!data.player || !data.player[0]) {
      return null;
    }

    const player = data.player[0];

    return {
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
    };
  } catch (error) {
    return null;
  }
}
export async function POST(request) {
  return handler(await request.json());
}