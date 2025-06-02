import { verifyToken } from '@clerk/backend';
import { sql } from '@vercel/postgres';

// Define the expected structure of the JWT payload
interface TokenPayload {
  user_id: string;
}

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

    // Verify the JWT from Clerk
    const { payload } = await verifyToken(token, {});

    // Cast payload to expected type
    const { user_id } = payload as TokenPayload;

    const result = await sql`
      SELECT * FROM user_tokens 
      WHERE user_id = ${user_id}
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
