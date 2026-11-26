export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_BASE_URL: string;
  SHOP_BASE_URL?: string;
  STOREFRONT_CHECKOUT_ENABLED?: string;
  WALLET_ENABLED?: string;
  ESSEN_BASE_URL?: string;
  ESSEN_LOCATION_ID?: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_WORKSPACE_DOMAIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM: string;
  CHECKOUT_ENABLED?: string;
  COFFEE_RECURRING_ENABLED?: string;
  SQUARE_ENVIRONMENT?: "sandbox" | "production";
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_LOCATION_ID?: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  SQUARE_WEBHOOK_URL?: string;
  SQUARE_CLIENT_ID?: string;
  SQUARE_CLIENT_SECRET?: string;
  SQUARE_SANDBOX_ITEM_IDS?: string;
  SQUARE_MONTHLY_PLAN_IDS?: string;
  ORDER_NOTIFICATION_EMAIL?: string;
}

export type GrantKind = "HSAP" | "MONTHLY";

export interface Grant {
  id: string;
  kind: GrantKind;
  valid_from: string;
  valid_until: string | null;
  revoked_at: string | null;
  evidence_id: string;
}

export interface Member {
  id: string;
  display_name: string;
  claim_email: string;
  hsap_id: string | null;
  auth_user_id: string | null;
  status: "active" | "blocked";
}
