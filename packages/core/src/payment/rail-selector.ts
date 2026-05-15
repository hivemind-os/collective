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
    const available = this.getAvailableRails(context);
    const selected = available[0];
    if (!selected) {
      throw new Error('No compatible payment rail is available for this task.');
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
