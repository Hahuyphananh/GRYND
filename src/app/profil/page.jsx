import PageClient from "./PageClient";

export const metadata = {
  title: "My Profile | GRYND",
  description:
    "Manage your GRYND profile. Track your balance, XP, level, titles, streaks and game statistics.",
};

export default function Page() {
  return <PageClient />;
}
