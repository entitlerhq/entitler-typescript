import { type Operation, route } from "./routes.js";
import { type Decoder, decodeFeatures, decodePricing } from "./shapes.js";
import type { ReadOptions, Transport } from "./transport.js";
import type { FeatureList, PricingSheet } from "./types.js";

/** Options for reading a customer's pricing. */
export interface CustomerPricingOptions extends ReadOptions {
  /** The BCP 47 locale to format amounts' `display` for, such as `en-AU`, sent as `Accept-Language`. */
  locale?: string;
}

/** Options for reading the plans on sale. */
export interface PricingOptions extends CustomerPricingOptions {
  /** The key of the market to price the plans in. */
  market?: string;
  /** The ISO 3166-1 country code whose market prices the plans, when `market` is left out. */
  country?: string;
}

function isLocale(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

/** Reads a pricing operation through the answer cache, in the locale asked for. @internal */
export async function readPricing<T>(
  transport: Transport,
  operation: Operation,
  variables: Record<string, string>,
  query: Record<string, string | undefined>,
  options: CustomerPricingOptions | undefined,
  decode: Decoder,
  customer?: string,
): Promise<T> {
  if (options?.locale !== undefined && !isLocale(options.locale)) {
    throw new TypeError("Pass locale as a BCP 47 language tag.");
  }
  const answer = await transport.send<T>({
    ...route(operation, variables, query),
    headers: { "Accept-Language": options?.locale },
    cached: true,
    ...(customer === undefined ? {} : { customer }),
    revalidate: options?.revalidate,
    decode,
    options,
  });
  return answer.data;
}

/** Reads the plans on sale on the default track, priced in a market when one is named. @internal */
export function pricing(transport: Transport, options: PricingOptions | undefined): Promise<PricingSheet> {
  return readPricing(
    transport,
    "Pricing.GetPricing",
    {},
    { market: options?.market, country: options?.country },
    options,
    decodePricing,
  );
}

/** Reads the catalogue's features served on the default track. @internal */
export async function features(transport: Transport, options: ReadOptions | undefined): Promise<FeatureList> {
  const answer = await transport.send<FeatureList>({
    ...route("Pricing.ListFeaturesOnSale", {}),
    cached: true,
    revalidate: options?.revalidate,
    decode: decodeFeatures,
    options,
  });
  return answer.data;
}
