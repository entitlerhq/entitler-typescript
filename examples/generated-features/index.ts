import { EntitlerServer } from "@entitlerhq/entitler";
import { features } from "./entitler.gen.ts";

const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const customer = server.customer(process.env.CUSTOMER_ID ?? "test_1001");

const credits = await customer.check(features.aiCredits);
console.log(`AI credits: ${credits.used} used, ${credits.remaining} left.`);

const seats = await customer.check(features.teamSeats);
console.log(`Team seats: ${seats.value}.`);

const entitlements = await customer.entitlements();
console.log(`Collaboration: ${entitlements.has(features.collaboration) ? "on" : "off"}.`);
