import { auth } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres'; // or your SQL client

export async function POST() {
  try {
    const { userId } = auth(); // replaces getSession

    if (!userId) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Utilisateur non authentifié" 
        }),
        { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const result = await sql`
      SELECT * FROM user_tokens 
      WHERE user_id = ${userId}
    `;

    if (result.rows.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Aucun token trouvé",
          shouldInitialize: true 
        }),
        { 
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        data: result.rows[0] 
      }),
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error("Error in get-user-tokens:", error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: "Erreur serveur" 
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}
