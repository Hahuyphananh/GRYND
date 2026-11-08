import PageClient from "./PageClient";

export const metadata = {
  alternates: { canonical: "/contact" },
  title: "Contact Us | GRYND",
  description:
    "Get in touch with the GRYND team about your account, a Solitaire match, GRYND PRO or a technical issue.",
};

export default function Page() {
  return <PageClient />;
}
