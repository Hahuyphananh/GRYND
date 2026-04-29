import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import GoonBetClickerClient from "../../components/goonbet/GoonBetClickerClient";

export default async function GoonBetClickerPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");
  return <GoonBetClickerClient />;
}
