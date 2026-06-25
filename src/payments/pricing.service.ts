import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface ComputeBookingInput {
  pricePerDay: number;
  days: number;
}

/**
 * Full money breakdown for a booking. Decimal fields are convenient snapshots
 * for display/persistence; the `*Minor` fields are integer minor units (cents)
 * and are the source of truth for every Stripe amount (Stripe only accepts
 * integers in the currency's smallest unit).
 */
export interface BookingPricing {
  currency: string;
  days: number;
  pricePerDay: number;
  rentalSubtotal: number;
  insurance: number;
  commission: number;
  total: number;
  sena: number;
  balance: number;
  deposit: number;
  ownerPayout: number;
  rentalSubtotalMinor: number;
  insuranceMinor: number;
  commissionMinor: number;
  totalMinor: number;
  senaMinor: number;
  balanceMinor: number;
  depositMinor: number;
  ownerPayoutMinor: number;
}

@Injectable()
export class PricingService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Computes every amount server-side so the client can never influence pricing.
   *
   * Money model: the renter pays `rentalSubtotal + insurance`. The platform
   * keeps the commission (taken out of the owner's payout) plus the insurance.
   * The owner receives `rentalSubtotal - commission`, transferred on check-out.
   * The deposit is a separate authorization hold, not part of the total.
   */
  computeBooking(input: ComputeBookingInput): BookingPricing {
    const { pricePerDay, days } = input;
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error("Booking day count must be a positive number");
    }
    if (!Number.isFinite(pricePerDay) || pricePerDay < 0) {
      throw new Error("Price per day must be a non-negative number");
    }

    const feePct = this.pct("PLATFORM_FEE_PCT", 0.1);
    const insurancePct = this.pct("INSURANCE_PCT", 0.1);
    const senaPct = this.pct("SENA_PCT", 0.3);
    const depositUsd = this.amount("DEPOSIT_DEFAULT_USD", 200);
    const currency = (this.config.get<string>("DEFAULT_CURRENCY") ?? "usd")
      .trim()
      .toLowerCase();

    const rentalSubtotalMinor = Math.round(pricePerDay * 100) * days;
    const insuranceMinor = Math.round(rentalSubtotalMinor * insurancePct);
    const commissionMinor = Math.round(rentalSubtotalMinor * feePct);
    const totalMinor = rentalSubtotalMinor + insuranceMinor;
    const senaMinor = Math.round(totalMinor * senaPct);
    const balanceMinor = totalMinor - senaMinor;
    const ownerPayoutMinor = rentalSubtotalMinor - commissionMinor;
    const depositMinor = Math.round(depositUsd * 100);

    return {
      currency,
      days,
      pricePerDay,
      rentalSubtotal: rentalSubtotalMinor / 100,
      insurance: insuranceMinor / 100,
      commission: commissionMinor / 100,
      total: totalMinor / 100,
      sena: senaMinor / 100,
      balance: balanceMinor / 100,
      deposit: depositMinor / 100,
      ownerPayout: ownerPayoutMinor / 100,
      rentalSubtotalMinor,
      insuranceMinor,
      commissionMinor,
      totalMinor,
      senaMinor,
      balanceMinor,
      depositMinor,
      ownerPayoutMinor,
    };
  }

  private pct(key: string, fallback: number): number {
    const parsed = Number.parseFloat(this.config.get<string>(key) ?? "");
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private amount(key: string, fallback: number): number {
    const parsed = Number.parseFloat(this.config.get<string>(key) ?? "");
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
