import PageClient from "./PageClient";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Accessibility",
  description: "GRYND is committed to accessibility. Keyboard navigation, screen-reader support, contrast, focus indicators and reduced motion.",
  path: "/accessibility",
  image: DEFAULT_OG_IMAGE,
});

export default function Page() {
  return <PageClient />;
}
