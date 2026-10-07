import PageClient from "./PageClient";

export const metadata = {
  alternates: { canonical: "/contact" },
  title: "Contact Us | GRYND",
  description:
    "Get in touch with the GRYND team. We're here to help with account, token, payment and gameplay questions.",
};

export default function Page() {
  return <PageClient />;
}
