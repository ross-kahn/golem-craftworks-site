// Shared types: the Worker's settings and the parts of the Square and Etsy APIs it uses.

export interface Env {
  GC_KV: KVNamespace;
  ASSETS?: Fetcher; // the static site (wrangler.toml [assets])

  // wrangler.toml [vars]
  SITE_URL?: string;
  ALLOWED_ORIGINS?: string;
  SQUARE_ENV?: string;
  SQUARE_VERSION?: string;
  SQUARE_LOCATION_ID: string;
  SQUARE_WEBHOOK_URL?: string;
  ETSY_KEYSTRING: string;
  ETSY_SHOP_ID: string;
  SHIPPING_FLAT_CENTS?: string;
  ONLINE_CATEGORIES?: string;
  HIDDEN_CATEGORIES?: string;
  SYNC_DRY_RUN?: string;
  EMAIL_FROM?: string;
  COMMISSION_TO?: string;

  // Secrets
  SQUARE_ACCESS_TOKEN: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  ETSY_SHARED_SECRET: string;
  ETSY_WEBHOOK_SECRET?: string;
  ADMIN_TOKEN?: string;
  RESEND_API_KEY?: string;
}

export type Ctx = Pick<ExecutionContext, "waitUntil">;

export type Fulfillment = "ship" | "pickup";

// ---------- Square ----------

export interface SquareMoney {
  amount: number;
  currency: string;
}

export interface SquareVariationData {
  name?: string;
  sku?: string;
  price_money?: SquareMoney;
  pricing_type?: string;
  sellable?: boolean;
  track_inventory?: boolean;
  location_overrides?: { location_id: string; track_inventory?: boolean }[];
  image_ids?: string[];
}

export interface SquareItemData {
  name?: string;
  description?: string;
  description_plaintext?: string;
  description_html?: string;
  is_archived?: boolean;
  categories?: { id: string }[];
  category_id?: string;
  reporting_category?: { id?: string };
  image_ids?: string[];
  variations?: SquareObject[];
}

export interface SquareObject {
  id: string;
  type?: string;
  is_deleted?: boolean;
  updated_at?: string;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_data?: SquareItemData;
  item_variation_data?: SquareVariationData;
  category_data?: { name?: string };
  image_data?: { url?: string };
}

export interface SquareCount {
  catalog_object_id: string;
  catalog_object_type?: string;
  location_id: string;
  state: string;
  quantity: string;
}

export interface SquareWebhookEvent {
  event_id?: string;
  type?: string;
  data?: { object?: { inventory_counts?: SquareCount[] } };
}

export interface StorefrontVariation {
  id: string;
  name: string;
  sku: string;
  priceCents: number;
  qty: number | null; // null: Square isn't counting stock for it
}

export interface StorefrontProduct {
  id: string;
  name: string;
  description: string;
  category: string;
  images: string[];
  variations: StorefrontVariation[];
  updatedAt?: string;
}

// ---------- Etsy ----------

export interface EtsyTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface EtsyListing {
  listing_id: number;
  state: string;
  quantity?: number;
  skus?: string[];
  title?: string;
}

export interface EtsyOffering {
  price: number | { amount: number; divisor: number };
  quantity: number;
  is_enabled?: boolean;
  is_deleted?: boolean;
}

export interface EtsyPropertyValue {
  property_id: number;
  value_ids: number[];
  scale_id?: number | null;
  property_name: string;
  values: string[];
}

export interface EtsyProduct {
  sku?: string;
  is_deleted?: boolean;
  property_values?: EtsyPropertyValue[];
  offerings?: EtsyOffering[];
}

export interface EtsyInventory {
  products: EtsyProduct[];
  price_on_property?: number[];
  quantity_on_property?: number[];
  sku_on_property?: number[];
}

export interface EtsyTransaction {
  transaction_id: number;
  sku?: string;
  quantity?: number;
  title?: string;
}

export interface EtsyReceipt {
  receipt_id: number;
  is_paid?: boolean;
  transactions?: EtsyTransaction[];
}

export interface EtsyWebhookEvent {
  event_type: string;
  resource_url: string;
}

// ---------- Sync results ----------

export interface PushResult {
  skipped?: string;
  unchanged?: boolean;
  dryRun?: boolean;
  updated?: boolean;
  sku?: string;
  listingId?: number;
  from?: number;
  to?: number;
  state?: string;
  plan?: string[];
}

export interface ReceiptResult {
  receiptId: number;
  skipped?: string;
  results?: unknown[];
}

export interface ReconcileReport {
  at: string;
  etsySalesChecked: number;
  lowered: { sku: string; listing: number; to?: number; dryRun: boolean }[];
  etsyLowerThanSquare: { listing: number; title?: string; etsy: number; square: number; state: string }[];
  squareOnly: string[];
  etsyOnly: string[];
  errors: string[];
}

export interface LogLine {
  at: string;
  message: string;
  data?: unknown;
}
