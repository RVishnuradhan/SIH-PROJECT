import type {
  PaymentStatus,
  PaymentType,
  RentalStatus,
  SettlementStatus,
} from "@/generated/prisma/enums";

import { assertPaise, sumPaise, type Paise } from "@/domain/money";

export type LedgerPayment = { type: PaymentType; status: PaymentStatus; amount: Paise };

export type BillMoney = {
  rentalCharges: Paise;
  extraCharges: Paise;
  received: Paise;
  refunded: Paise;
  discounts: Paise;
  pending: Paise;
  /** > 0: the customer owes this much · < 0: a refund is due. Final once RETURNED or voided. */
  balance: Paise;
};

/**
 * A bill's money, always calculated from its ledgers — never from stored totals
 * (principle P5). Mirrors the `bill_financials` database view.
 *
 * @param batchAmounts amounts of the bill's return-batch lines, voided returns excluded
 * @param charges non-rental charges, voided ones excluded (always empty in V1)
 */
export function summarizeBillMoney({
  batchAmounts,
  charges = [],
  payments,
}: {
  batchAmounts: readonly Paise[];
  charges?: readonly Paise[];
  payments: readonly LedgerPayment[];
}): BillMoney {
  const total = (predicate: (payment: LedgerPayment) => boolean) =>
    sumPaise(payments.filter(predicate).map((payment) => assertPaise(payment.amount)));

  const rentalCharges = sumPaise(batchAmounts);
  const extraCharges = sumPaise(charges);
  const received = total(
    (p) => p.status === "COMPLETED" && (p.type === "ADVANCE" || p.type === "ADDITIONAL"),
  );
  const refunded = total((p) => p.status === "COMPLETED" && p.type === "REFUND");
  const discounts = total((p) => p.status === "COMPLETED" && p.type === "DISCOUNT");
  const pending = total(
    (p) => p.status === "PENDING" && (p.type === "ADVANCE" || p.type === "ADDITIONAL"),
  );

  return {
    rentalCharges,
    extraCharges,
    received,
    refunded,
    discounts,
    pending,
    balance: assertPaise(rentalCharges + extraCharges - discounts - (received - refunded)),
  };
}

/**
 * Settlement status (decision A8), separate from the rental status:
 * - DRAFT, or a cancelled draft → NO_DUE
 * - materials still out → PAYMENT_PENDING if a promised payment hasn't arrived, else NO_DUE
 *   (money is settled only when everything is back — decision A2)
 * - RETURNED or voided → ADDITIONAL_DUE / REFUND_DUE by the sign of the balance;
 *   SETTLED at zero once money was involved; NO_DUE if no money was ever involved
 */
export function deriveSettlementStatus({
  rentalStatus,
  wasGenerated,
  money,
}: {
  rentalStatus: RentalStatus;
  /** For CANCELLED bills: true when a generated bill was voided, false for a cancelled draft. */
  wasGenerated: boolean;
  money: BillMoney;
}): SettlementStatus {
  switch (rentalStatus) {
    case "DRAFT":
      return "NO_DUE";
    case "ACTIVE":
    case "PARTIALLY_RETURNED":
      return money.pending > 0 ? "PAYMENT_PENDING" : "NO_DUE";
    case "CANCELLED":
      if (!wasGenerated) return "NO_DUE";
      break;
    case "RETURNED":
      break;
  }
  if (money.balance > 0) return "ADDITIONAL_DUE";
  if (money.balance < 0) return "REFUND_DUE";
  const moneyInvolved =
    money.rentalCharges + money.extraCharges + money.received + money.refunded + money.discounts >
    0;
  return moneyInvolved ? "SETTLED" : "NO_DUE";
}
