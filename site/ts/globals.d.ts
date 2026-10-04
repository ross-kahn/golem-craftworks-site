// Types shared by the site scripts. Each script is a plain <script> file, so these are global.

interface SiteConfig {
  apiBase: string;
  shopName: string;
  contactEmail: string;
  instagramUrl: string;
  etsyUrl: string;
  shippingLabel: string;
  shippingCents: number;
  pickupLabel: string;
  pickupNote: string;
  currency: string;
}

// A product as the Worker (or demo-products.json) sends it.
interface RawVariation {
  id: string;
  name: string;
  priceCents: number;
  qty?: number | null;
  sku?: string;
}

interface RawProduct {
  id: string;
  slug?: string;
  name: string;
  category?: string;
  optionLabel?: string;
  description?: string;
  images?: string[];
  variations?: RawVariation[];
  unique?: boolean;
  updatedAt?: string;
}

interface Variation extends RawVariation {
  available: number;
}

interface Product extends Omit<RawProduct, "variations" | "unique"> {
  variations: Variation[];
  soldOut: boolean;
  unique: boolean;
  minPrice: number | null;
  maxPrice: number | null;
}

type Fulfillment = "ship" | "pickup";

interface CartLine {
  variationId: string;
  productId: string;
  name: string;
  variationName: string;
  priceCents: number;
  image: string;
  qty: number;
  max: number;
}

interface CommissionData {
  name: string;
  email: string;
  type: string;
  idea: string;
  when: string;
  budget: string;
  website: string;
}

interface ApiError extends Error {
  status?: number;
  body?: { error?: string; soldOut?: string[] } | null;
  demo?: boolean;
}

interface GCApi {
  getProducts(opts?: { fresh?: boolean }): Promise<Product[]>;
  getProduct(id: string): Promise<Product | null>;
  createCheckout(order: { lines: CartLine[]; fulfillment: Fulfillment }): Promise<{ url?: string }>;
  sendCommission(data: CommissionData): Promise<{ ok: boolean; confirmationSent: boolean }>;
  money(cents: number | null | undefined): string;
  priceLabel(p: Product): string;
  isDemo(): boolean;
  siteRoot(): string;
}

type CartAddResult = { ok: true } | { ok: false; reason: string };

interface GCCart {
  lines(): CartLine[];
  count(): number;
  add(product: Product, variation: Variation, qty?: number): CartAddResult;
  setQty(variationId: string, qty: number): void;
  clear(): void;
}

interface GCSite {
  cart: GCCart;
  openCart(): void;
  toast(msg: string): void;
  esc(s: unknown): string;
  root: string;
}

interface Window {
  GC_CONFIG: SiteConfig;
  GC_API: GCApi;
  GC: GCSite;
}
