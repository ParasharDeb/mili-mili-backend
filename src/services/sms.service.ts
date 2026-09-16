import { isProduction } from "../lib/env.ts";

/**
 * Delivery stub. Wire a real provider (Twilio, MSG91, ...) here.
 * In development the code is logged so you can test without an SMS account.
 */
export async function sendSms(phone: string, message: string): Promise<void> {
  if (!isProduction) {
    console.log(`[sms] -> ${phone}: ${message}`);
    return;
  }

  throw new Error(
    "No SMS provider configured. Implement sendSms() in src/services/sms.service.ts before deploying.",
  );
}
