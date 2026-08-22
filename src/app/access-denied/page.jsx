import PageClient from "./PageClient";

export const metadata = {
  title: "Access Denied — GRYND",
  description:
    "You must be at least 18 years old to access GRYND. This restriction is in place to comply with applicable regulations.",
};

export default function Page() {
  return <PageClient />;
}
