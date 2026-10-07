import type { JsonLdNode } from "../../lib/reviewJsonLd";

/**
 * Renders structured data as `application/ld+json` script tags.
 *
 * THE one place JSON-LD reaches the DOM, so no page has to copy a JSON blob
 * inline and the serialisation rules are enforced once:
 *
 *  • `<` is escaped to `\u003c`. `JSON.stringify` leaves it alone, and a
 *    literal `</script>` inside a string value would close the script element
 *    early and dump the rest of the markup into the page as text. The escape is
 *    a valid JSON string escape (so the data parses back unchanged) and the
 *    emitted bytes can no longer terminate the tag. Today every value comes
 *    from the curated catalogue, but the component is shared and must stay safe
 *    when a value is eventually user-supplied (review bodies already are).
 *
 *  • `null`/empty nodes render nothing at all. Structured data that describes
 *    nothing is worse than absent structured data, so a page with no real
 *    claim to make emits no markup rather than an empty node.
 *
 * Server component by design: it takes already-built plain data, renders no
 * interactive markup, and depends on no browser API — so the JSON-LD is in the
 * server-rendered HTML, before any script runs and with nothing to hydrate.
 *
 * Usage:
 *   <JsonLd data={buildGameStructuredData(slug)} />   // several nodes
 *   <JsonLd data={buildWebsiteJsonLd()} />            // one node
 */
export default function JsonLd({ data }: { data?: JsonLdNode | JsonLdNode[] | null }) {
  const nodes = (Array.isArray(data) ? data : [data]).filter((node): node is JsonLdNode =>
    Boolean(node)
  );
  if (nodes.length === 0) return null;

  return (
    <>
      {nodes.map((node, index) => (
        <script
          key={index}
          type="application/ld+json"
          // Serialised here and nowhere else — see the `<` note above.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(node).replace(/</g, "\\u003c") }}
        />
      ))}
    </>
  );
}
