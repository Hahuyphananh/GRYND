import PageClient from "./PageClient";

export const metadata = {
  robots: { index: false, follow: false },

  title: "Verification Required | GRYND",
  description:
    "Verify your identity with a one-time code to continue on GRYND.",
};

export default function Page() {
  return <PageClient />;
}