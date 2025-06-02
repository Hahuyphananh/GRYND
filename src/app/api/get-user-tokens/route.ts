import { verifyToken } from '@clerk/backend';
import { sql } from '@vercel/postgres';

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Jeton manquant' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '').trim();

    // Verify the JWT from Clerk using your custom template
const { payload } = await verifyToken(token, {});



    const userId = payload.user_id; // comes from your custom claim

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
