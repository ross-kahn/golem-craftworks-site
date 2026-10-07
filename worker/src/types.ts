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
  SQUARE_SALES_SINCE?: string; // date from which Square sales are added to the public sales count (reviews.ts)
  ONLINE_CATEGORIES?: string;
  HIDDEN_CATEGORIES?: string;
  SYNC_DRY_RUN?: string;
  ETSY_DRAFT_CATEGORIES?: string; // Square categories whose new items get an Etsy draft (drafts.ts)
  ETSY_DRAFTS_AUTO_PUBLISH?: string; // "true" publishes those drafts straight away
  NOINDEX?: string; // "true" keeps search engines away (the pre-launch preview address)
  EMAIL_FROM?: string;
  COMMISSION_TO?: string;
  SALES_TO?: string; // where website order emails go (sales.ts); COMMISSION_TO if empty
  DEMO_CATALOG?: string; // set by `npm run dev`: sample products when there's no Square token

  // Secrets
  SQUARE_ACCESS_TOKEN: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  ETSY_SHARED_SECRET: string;
  ETSY_WEBHOOK_SECRET?: string;
  ADMIN_TOKEN?: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SECRET?: string;
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
  location_overrides?: { location_id: string; track_inventory?: boolean; sold_out?: boolean }[];
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
  modifier_list_info?: SquareModifierListInfo[];
}

// How one item uses a modifier list. -1 (or missing) on min/max means "use the list's own setting".
export interface SquareModifierListInfo {
  modifier_list_id: string;
  enabled?: boolean;
  ordinal?: number;
  min_selected_modifiers?: number;
  max_selected_modifiers?: number;
  modifier_overrides?: {
    modifier_id: string;
    on_by_default?: boolean; // older field
    on_by_default_override?: string; // YES | NO | NOT_SET
    hidden_online_override?: string;
  }[];
}

export interface SquareModifierListData {
  name?: string;
  selection_type?: string; // SINGLE | MULTIPLE (older field)
  modifier_type?: string; // LIST | TEXT
  min_selected_modifiers?: number;
  max_selected_modifiers?: number;
  modifiers?: SquareObject[];
}

export interface SquareModifierData {
  name?: string;
  price_money?: SquareMoney;
  on_by_default?: boolean;
  hidden_online?: boolean;
  ordinal?: number;
  location_overrides?: { location_id: string; price_money?: SquareMoney; sold_out?: boolean }[];
}

export interface SquareObject {
  id: string;
  type?: string;
  is_deleted?: boolean;
  created_at?: string;
  updated_at?: string;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_data?: SquareItemData;
  item_variation_data?: SquareVariationData;
  category_data?: { name?: string };
  image_data?: { url?: string };
  modifier_list_data?: SquareModifierListData;
  modifier_data?: SquareModifierData;
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
  data?: { object?: { inventory_counts?: SquareCount[]; payment?: SquarePayment } };
}

// The parts of a Square payment the sale email uses.
export interface SquarePayment {
  status?: string;
  order_id?: string;
  note?: string;
  buyer_email_address?: string;
  total_money?: SquareMoney;
  processing_fee?: { amount_money?: SquareMoney }[];
  receipt_url?: string;
  shipping_address?: SquareAddress;
}

export interface SquareAddress {
  first_name?: string; last_name?: string; address_line_1?: string; address_line_2?: string; address_line_3?: string;
  locality?: string; administrative_district_level_1?: string; postal_code?: string; country?: string;
}

export interface StorefrontVariation {
  id: string;
  name: string;
  sku: string;
  priceCents: number;
  qty: number | null; // null: Square isn't counting stock for it
}

export interface StorefrontModifier {
  id: string;
  name: string;
  priceCents: number;
  default: boolean; // selected when the product page opens
}

// A group of add-ons the buyer picks from: at least `min`, at most `max`.
export interface StorefrontModifierList {
  id: string;
  name: string;
  min: number;
  max: number;
  modifiers: StorefrontModifier[];
}

export interface StorefrontProduct {
  id: string;
  slug: string; // the readable part of its address: /product/<slug>
  name: string;
  description: string;
  category: string;
  images: string[];
  variations: StorefrontVariation[];
  modifierLists: StorefrontModifierList[];
  createdAt?: string; // when the item was added to Square: the shop's display order, newest first
  updatedAt?: string;
}

// What the site and its pages are given: no SKUs, which are internal.
export type PublicProduct = Omit<StorefrontProduct, "variations"> & { variations: Omit<StorefrontVariation, "sku">[] };

export interface StorefrontCatalog {
  products: PublicProduct[];
  generatedAt: string;
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
  // Settings a new draft copies from the template listing (drafts.ts).
  who_made?: string;
  when_made?: string;
  taxonomy_id?: number;
  shipping_profile_id?: number | null;
  return_policy_id?: number | null;
  shop_section_id?: number | null;
  tags?: string[];
  materials?: string[];
  is_supply?: boolean;
  should_auto_renew?: boolean;
  processing_min?: number | null;
  processing_max?: number | null;
  item_weight?: number | null;
  item_weight_unit?: string | null;
  item_length?: number | null;
  item_width?: number | null;
  item_height?: number | null;
  item_dimensions_unit?: string | null;
}

export interface EtsyOffering {
  price: number | { amount: number; divisor: number };
  quantity: number;
  readiness_state_id?: number; // how soon it ships (an Etsy processing profile)
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

// ---------- Reviews ----------

// A review as the site shows it, from Etsy or left on the site.
export interface PublicReview {
  id: string;
  source: "etsy" | "site";
  name: string;
  rating: number;
  text: string;
  product: string;
  photos: string[];
  at: string;
}

// A review left on the site, as stored. No email address: that only goes out in the notification email.
export interface SiteReview {
  id: string;
  key: string; // secret for this review's private link (hide, show, delete)
  status: "pending" | "approved"; // hidden | showing
  name: string;
  rating: number;
  text: string;
  product: string;
  photoTypes: string[]; // content type of each stored photo
  at: string;
}

export interface EtsyReviewCache {
  v?: number;
  at: number;
  sales: number | null; // all-time sales, as shown on the Etsy shop
  squareSales?: number; // items sold in Square since SQUARE_SALES_SINCE
  count: number;
  average: number | null;
  reviews: PublicReview[];
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
  changed: { sku: string; listing: number; from?: number; to?: number; dryRun: boolean }[];
  // In stock in Square but not on sale on Etsy: the sync never republishes, so these wait for you.
  notPublished: { listing: number; title?: string; state: string; square: number }[];
  squareOnly: string[];
  etsyOnly: string[];
  errors: string[];
}

export interface DraftReport {
  at: string;
  dryRun: boolean;
  created: { sku: string; listingId: number; title: string; photos: number; published: boolean }[];
  waiting: string[]; // SKUs that qualify but weren't made this run
  photosUpdated: { sku: string; listingId: number; photos: number }[];
  photosWaiting: string[]; // SKUs whose Square photos changed but Etsy's weren't replaced this run
  errors: string[];
}

export interface LogLine {
  at: string;
  message: string;
  data?: unknown;
}
