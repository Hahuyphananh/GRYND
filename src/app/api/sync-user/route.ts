import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { db } from '../../../db/client';
import { users } from '../../../db/schema';
import { eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: 'Unauthorized - No session' }, { status: 401 });
    }

    const client = await clerkClient();
    let clerkUser = null;

for (let i = 0; i < 3; i++) {
  try {
    clerkUser = await client.users.getUser(clerkId);
    if (clerkUser) break;
  } catch (e) {
    console.warn("Retrying Clerk user fetch...", i);
    await new Promise((r) => setTimeout(r, 300));
  }
}

if (!clerkUser) {
  return NextResponse.json(
    { error: "Clerk user not ready yet" },
    { status: 400 }
  );
}
    const name = `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim();
    const email = clerkUser.emailAddresses?.[0]?.emailAddress || 'unknown@example.com';
    const profilePicture = clerkUser.imageUrl || null;

    const existing = await db.select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
    if (existing.length > 0) {
      return NextResponse.json({ message: 'User already exists' }, { status: 200 });
    }

    let rawPassword = crypto.randomBytes(32).toString('hex');
    try {
      const body = await req.json();
      if (body?.password) {
        rawPassword = String(body.password);
        try {
          await client.users.updateUser(clerkId, { password: rawPassword });
        } catch (err) {
          console.warn('⚠️ Clerk password update failed:', err);
          rawPassword = crypto.randomBytes(32).toString('hex');
        }
      }
    } catch (err) {
      console.warn('⚠️ Invalid JSON body:', err);
    }

    const passwordHash = await bcrypt.hash(rawPassword, 12);

    const inserted = await db.insert(users).values({
      clerkId,
      name,
      email,
      password: passwordHash,
      profilePicture,
    }).returning();

    const newUser = inserted[0];

// 🔥 CREATE USER_STATS ROW

await db.execute(sql`
  INSERT INTO user_secret_stats (user_id, day_key, day_start_balance, last_known_balance)
  VALUES (${newUser.id}, ${new Date().toISOString().slice(0, 10)}, ${newUser.balance ?? '1000.00'}, ${newUser.balance ?? '1000.00'})
  ON CONFLICT (user_id) DO NOTHING
`);

await db.execute(sql`
  INSERT INTO user_stats (user_id)
  VALUES (${newUser.id})
  ON CONFLICT (user_id) DO NOTHING
`);

    return NextResponse.json(
      { message: 'User synced successfully', user: inserted[0] },
      { status: 201 }
    );
  } catch (error) {
    console.error('❌ Error in /api/sync-user:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
