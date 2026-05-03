import { resend } from "../../../../lib/resend";

export async function GET() {
  const { data, error } = await resend.emails.send({
    from: "GoonBet <noreply@mail.goonbet.dedyn.io>",
    to: "phananhalbert@gmail.com",
    subject: "Test Email",
    html: "<h1>Email works 🎉</h1>",
  });

  if (error) {
    return Response.json({ error }, { status: 500 });
  }

  return Response.json({ success: true, data });
}