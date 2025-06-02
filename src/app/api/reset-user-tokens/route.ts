import { auth } from "@clerk/nextjs"; // ✅ utilise le bon auth pour App Router
import { sql } from "@vercel/postgres";

export async function POST() {
  try {
    const { userId } = auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = jwt.sign(
      { userId, action: 'reset-tokens', timestamp: Date.now() },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const result = await sql`
      UPDATE users
      SET balance = 1000.00
      WHERE clerk_id = ${userId}
      RETURNING balance
    `;

    if (result.rowCount === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json(
      { 
        success: true,
        balance: result.rows[0].balance,
        token: token // Return token without storing it
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}