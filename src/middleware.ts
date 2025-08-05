import { NextResponse } from "next/server";

export default function middleware(req) {
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'],
};
