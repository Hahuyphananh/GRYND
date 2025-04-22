import { getSession } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres'; // ou votre client SQL

export async function POST(request) {
  try {
    const session = await getSession(request);
    
    if (!session?.userId) {
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
      WHERE user_id = ${session.userId}
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