import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";

const JWT_SECRET = process.env.JWT_SECRET || 'your-very-secure-default-secret';

export async function POST() {
  try {
    // Add await here to properly get the auth object
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId, action: 'reset-tokens', timestamp: Date.now() },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Update user's balance in the users table
    const result = await sql`
      UPDATE users
      SET 
        balance = 1000.00,
        token = ${token}
      WHERE clerk_id = ${userId}
      RETURNING balance, token
    `;

    // If no rows were updated, the user might not exist
    if (result.rowCount === 0) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { 
        success: true,
        balance: result.rows[0].balance,
        token: result.rows[0].token
      },
      { status: 200 }
    );

  } catch (error) {
    console.error("Error in reset-user-token:", error);
    return NextResponse.json(
      { 
        error: "Internal Server Error",
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}