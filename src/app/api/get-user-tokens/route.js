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

    const userId = payload.sub;

    const result = await sql`
      SELECT * FROM user_tokens 
      WHERE user_id = ${userId}
    `;

    if (result.rows.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Aucun token trouvé',
          shouldInitialize: true,
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, data: result.rows[0] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Erreur dans get-user-tokens:', error);
    return new Response(
      JSON.stringify({ success: false, error: 'Erreur serveur' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
