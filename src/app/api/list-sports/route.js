export async function POST() {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/odds/fetch`, {
      method: "POST",
    });

    const json = await res.json();
    if (!json.success) throw new Error("Failed to fetch sports");

    // Map and transform data if needed
    const sports = json.data.map(sport => ({
      id: sport.key,
      name: sport.title,
      icon_name: "futbol", // Optional: map by sport.key
    }));

    return new Response(JSON.stringify({ sports }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Erreur serveur" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
