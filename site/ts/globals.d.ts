// Types the site scripts share. Nothing here is imported: they're global to everything in ts/.

interface SiteConfig {
  shopName: string;
  contactEmail: string;
  instagramUrl: string;
  etsyUrl: string;
  turnstileSiteKey: string;
  shippingLabel: string;
  shippingCents: number;
  pickupLabel: string;
  pickupNote: string;
  currency: string;
}

// A product as the Worker sends it.
interface RawVariation {
  id: string;
  name: string;
  priceCents: number;
  qty?: number | null;
  sku?: string;
}

interface Modifier {
  id: string;
  name: string;
  priceCents: number;
  default?: boolean; // selected when the product page opens
}

// A group of add-ons from Square: the buyer picks at least `min` and at most `max`.
interface ModifierList {
  id: string;
  name: string;
  min: number;
  max: number;
  modifiers: Modifier[];
}

interface RawProduct {
  id: string;
  slug: string;
  name: string;
  category?: string;
  optionLabel?: string;
  description?: string;
  images?: string[];
  variations?: RawVariation[];
  modifierLists?: ModifierList[];
  unique?: boolean;
  updatedAt?: string;
}

interface Variation extends RawVariation {
  available: number;
}

interface Product extends Omit<
  RawProduct,
  "category" | "variations" | "modifierLists" | "unique"
> {
  category: string; // "Other" when Square has none
  variations: Variation[];
  modifierLists: ModifierList[];
  soldOut: boolean;
  unique: boolean;
  minPrice: number | null;
  maxPrice: number | null;
}

interface Review {
  id: string;
  source: "etsy" | "site";
  name: string;
  rating: number;
  text: string;
  product: string;
  photos: string[];
  at: string;
}

interface ReviewData {
  reviews: Review[];
  stats: { count: number; average: number | null; sales: number | null };
}

type Fulfillment = "ship" | "pickup";

interface CartLine {
  key: string; // variation plus chosen add-ons: the same piece with different add-ons is its own line
  variationId: string;
  productId: string;
  name: string;
  variationName: string;
  modifiers: { id: string; name: string }[];
  priceCents: number; // each, add-ons included
  image: string;
  qty: number;
  max: number; // stock for the variation, shared by every line that uses it
}

interface ApiError extends Error {
  status?: number;
  body?: { error?: string; soldOut?: string[]; changed?: string[] } | null;
}

type CartAddResult = { ok: true } | { ok: false; reason: string };

interface GCCart {
  lines(): CartLine[];
  count(): number;
  inCart(variationId: string): number; // how many of a variation, across all of its lines
  add(
    product: Product,
    variation: Variation,
    qty?: number,
    modifiers?: Modifier[],
  ): CartAddResult;
  setQty(key: string, qty: number): void;
  clear(): void;
}

interface Window {
  GC_CONFIG: SiteConfig;
}
