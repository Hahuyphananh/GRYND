import PageClient from "./PageClient";

export const metadata = {
  robots: { index: false, follow: false },

  title: "Verify Your Age | GRYND",
  description:
    "Confirm your date of birth to finish setting up your GRYND profile and start playing competitive PvP games.",
};

export default function Page() {
  return <PageClient />;
}
