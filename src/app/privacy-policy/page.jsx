import PageClient from "./PageClient";

export const metadata = {
  alternates: { canonical: "/privacy-policy" },
  title: "Privacy Policy | GRYND",
  description:
    "Learn how GRYND collects, uses and protects your personal data. Including cookies, retention, your rights and compliance.",
};

export default function Page() {
  return <PageClient />;
}
