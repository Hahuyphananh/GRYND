async function handler() {
  const sports = await sql`
    SELECT id, name, icon_name 
    FROM sports 
    WHERE is_active = true 
    ORDER BY name ASC
  `;

  return { sports };
}
export async function POST(request) {
  return handler(await request.json());
}