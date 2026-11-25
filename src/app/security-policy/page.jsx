import PageClient from "./PageClient";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Security Policy",
  description: "Discover how GRYND protects your account and data. Encryption, account security, payment security and vulnerability management.",
  path: "/security-policy",
  image: DEFAULT_OG_IMAGE,
});

export default function Page() {
  return <PageClient />;
}
