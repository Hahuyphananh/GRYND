import PageClient from "./PageClient";

export const metadata = {
  robots: { index: false, follow: false },

  title: "Settings | GRYND",
  description:
    "Manage your GRYND settings: sound, language, account links and more.",
};

export default function Page() {
  return <PageClient />;
}