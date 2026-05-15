import type { HashChainProof, MeteringReport } from '@agentic-mesh/types';

import { HashChain, createMeteringSeed } from './hash-chain.js';

const MAX_U64 = (1n << 64n) - 1n;
const MAX_RECORDED_UNITS = Number.MAX_SAFE_INTEGER;

export interface UsageMeterOptions {
  taskId: string;
  maxPrice: bigint;
  unitPrice?: bigint;
  seed?: Uint8Array;
}

export class UsageMeter {
  private readonly hashChain: HashChain;
  private actualUnits = 0;
  private readonly taskId: string;
  private readonly maxPrice: bigint;
  private readonly unitPrice: bigint;

  constructor(options: UsageMeterOptions) {
    const taskId = options.taskId.trim();
    const maxPrice = options.maxPrice;
    const unitPrice = options.unitPrice ?? 0n;
    if (!taskId) {
      throw new Error('taskId is required.');
    }
    if (maxPrice < 0n || unitPrice < 0n) {
      throw new Error('maxPrice and unitPrice must be non-negative.');
    }
    if (maxPrice > MAX_U64 || unitPrice > MAX_U64) {
      throw new Error('maxPrice and unitPrice must fit in an unsigned 64-bit integer.');
    }

    this.taskId = taskId;
    this.maxPrice = maxPrice;
    this.unitPrice = unitPrice;
    this.hashChain = new HashChain(options.seed ?? createMeteringSeed(taskId));
  }

  recordUnit(data: Uint8Array): number {
    if (this.actualUnits >= MAX_RECORDED_UNITS) {
      throw new Error('Too many metering units recorded.');
    }

    this.hashChain.addUnit(data);
    this.actualUnits += 1;
    return this.actualUnits;
  }

  getActualUnits(): number {
    return this.actualUnits;
  }

  getVerificationHash(): string {
    return this.hashChain.getRoot();
  }

  getProof(): HashChainProof {
    return this.hashChain.getProof();
  }

  getCost(unitPrice = this.unitPrice): bigint {
    const uncapped = BigInt(this.actualUnits) * unitPrice;
    return uncapped > this.maxPrice ? this.maxPrice : uncapped;
  }

  getReport(): MeteringReport {
    const actualCost = this.getCost();
    return {
      taskId: this.taskId,
      actualUnits: this.actualUnits,
      actualCost,
      maxPrice: this.maxPrice,
      refundAmount: this.maxPrice - actualCost,
      verificationHash: this.getVerificationHash(),
    };
  }
}
