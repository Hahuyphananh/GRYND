import PageClient from "./PageClient";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Terms & Conditions",
  description: "Read the GRYND terms and conditions. Eligibility, account responsibility, fair play, prohibited conduct and more.",
  path: "/terms",
  image: DEFAULT_OG_IMAGE,
});

export default function Page() {
  return <PageClient />;
}
