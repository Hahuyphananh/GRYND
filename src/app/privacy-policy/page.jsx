import PageClient from "./PageClient";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Privacy Policy",
  description: "Learn how GRYND collects, uses and protects your personal data. Including cookies, retention, your rights and compliance.",
  path: "/privacy-policy",
  image: DEFAULT_OG_IMAGE,
});

export default function Page() {
  return <PageClient />;
}
