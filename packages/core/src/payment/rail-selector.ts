export type SelectedPaymentRail = 'sui-escrow' | 'sui-transfer' | 'x402-base';

export interface RailSelectionContext {
  executionMode: 'sync' | 'async';
  consumerHasSuiWallet: boolean;
  consumerHasEvmWallet: boolean;
  providerAcceptsSui: boolean;
  providerAcceptsX402: boolean;
  amount: bigint;
  currency: string;
}

export class PaymentRailSelector {
  selectRail(context: RailSelectionContext): SelectedPaymentRail {
    if (context.amount < 0n) {
      throw new Error(`Invalid payment amount: ${context.amount}. Amount must be non-negative.`);
    }

    if (!context.currency || context.currency.trim().length === 0) {
      throw new Error('Payment currency is required for rail selection.');
    }

    const available = this.getAvailableRails(context);
    const selected = available[0];
    if (!selected) {
      throw new Error(
        `No compatible payment rail is available for ${context.amount} ${context.currency} ` +
        `(mode: ${context.executionMode}, sui: ${context.consumerHasSuiWallet}/${context.providerAcceptsSui}, ` +
        `evm: ${context.consumerHasEvmWallet}/${context.providerAcceptsX402}).`,
      );
    }

    return selected;
  }

  getAvailableRails(context: RailSelectionContext): SelectedPaymentRail[] {
    if (context.executionMode === 'async') {
      return context.consumerHasSuiWallet && context.providerAcceptsSui ? ['sui-escrow'] : [];
    }

    const rails: SelectedPaymentRail[] = [];

    if (context.consumerHasSuiWallet && context.providerAcceptsSui) {
      rails.push('sui-transfer');
    }

    if (context.consumerHasEvmWallet && context.providerAcceptsX402) {
      rails.push('x402-base');
    }

    return rails;
  }
}
