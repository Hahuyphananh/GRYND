import { verifyToken } from '@clerk/backend';
import { sql } from '../../../db/client';

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing token' }), { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '').trim();

    let payload;
    try {
      const { payload: verifiedPayload } = await verifyToken(token, {
  authorizedParties: ['betsim-app'], // 👈 sets the audience
});
      payload = verifiedPayload;
    } catch (err) {
      console.error('Invalid token:', err);
      return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 403 });
    }

    const clerkId = payload.sub;
    const name = payload.name || '';
    const email = payload.email;

    const existing = await sql`
      SELECT * FROM users WHERE clerk_id = ${clerkId}
    `;

    if (existing.length > 0) {
      return new Response(JSON.stringify({ message: 'User already synced' }), { status: 200 });
    }

    await sql`
      INSERT INTO users (clerk_id, name, email, password)
      VALUES (${clerkId}, ${name}, ${email}, 'placeholder-password')
    `;

    return new Response(JSON.stringify({ message: 'User synced' }), { status: 201 });
  } catch (error) {
    console.error('Server error:', error);
    return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
  }
}
