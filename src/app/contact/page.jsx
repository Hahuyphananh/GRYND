import PageClient from "./PageClient";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Contact",
  description: "Get in touch with the GRYND team about your account, a Solitaire match, GRYND PRO or a technical issue.",
  path: "/contact",
  image: DEFAULT_OG_IMAGE,
});

export default function Page() {
  return <PageClient />;
}
