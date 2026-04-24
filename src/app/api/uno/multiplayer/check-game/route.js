import { POST as multiplayerPost } from "../route";

export async function POST(request) {
  const payload = await request.json();
  const proxied = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ ...payload, action: "check-game" }),
  });
  return multiplayerPost(proxied);
}
