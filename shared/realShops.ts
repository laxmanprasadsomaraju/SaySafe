/**
 * "That's not in the Demo Shop" → real shops (Channel3). Shared by the server and the Assistant so typed and spoken
 * requests behave the same. SaySafe never promises a real-shop search that doesn't run.
 */

/** Spoken/typed requests to search real shops: "search real shops", "real product search", "real shops",
 *  "search real products", "look in real shops for a kettle". Returns the product named after "for", if any. */
export function realShopSearch(text: string): { query: string | null } | null {
  const s = text.toLowerCase().replace(/[’']/g, "'").replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 120) return null;
  const m = s.match(/^(?:(?:please|ok|okay|yes|yeah|can you|could you|now)[, ]+)*(?:(?:search|look|check|try|find|show me|use)(?: (?:in|on|at|for|the|me))* )?(?:the )?real[- ](?:shops?|stores?|retailers?|products?|listings?)(?: search)?(?: (?:search|instead|please|then|now))*(?: for (.{2,80}))?$/)
    ?? s.match(/^(?:(?:search|look|check|find)(?: in| on| at)? )(?:the )?real[- ](?:shops?|stores?|products?)(?: for)? (.{2,80})$/);
  if (!m) return null;
  const q = m[1]?.replace(/^(a|an|the|some)\s+/, '').trim() || null;
  return { query: q };
}

export const NOT_IN_DEMO = "That's not in the Demo Shop.";
/** What SaySafe SAYS when the product isn't in the Demo Shop and no real listings are on screen. */
export const NOT_IN_DEMO_SPOKEN = "That's not in the Demo Shop. Say 'search real shops' to find real products, or pick a demo item.";
/** Spoken when real listings were found and shown above the Demo Shop chips. */
export const NOT_IN_DEMO_FOUND_SPOKEN = "That's not in the Demo Shop, but I found it at real shops. You'd buy those on the retailer's own website, or you can pick a demo item.";
