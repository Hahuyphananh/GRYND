import { verifyToken } from '@clerk/backend';
import { sql } from '@vercel/postgres';

export async function POST(req) {
  try {
    const authHeader = req.headers.get('authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Jeton manquant' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '').trim();

    let payload;
    try {
      const { payload: verifiedPayload } = await verifyToken(token);
      payload = verifiedPayload;
    } catch (err) {
      return new Response(
        JSON.stringify({ success: false, error: 'Jeton invalide' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const clerkId = payload.sub;
    const name = payload.name || '';
    const email = payload.email;

    // Check if user already exists
    const { rows } = await sql`
      SELECT * FROM users WHERE clerk_id = ${clerkId}
    `;

    if (rows.length > 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'Utilisateur déjà synchronisé' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Insert new user
    await sql`
      INSERT INTO users (clerk_id, name, email, password)
      VALUES (${clerkId}, ${name}, ${email}, 'placeholder-password')
    `;

    return new Response(
      JSON.stringify({ success: true, message: 'Utilisateur synchronisé' }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Erreur dans sync-user:', error);
    return new Response(
      JSON.stringify({ success: false, error: 'Erreur serveur' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
