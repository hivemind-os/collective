import type { Signer } from '@mysten/sui/cryptography';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import type { SessionState, SessionStateChangeCallback } from './session-state.js';

export type AuthMode = 'ed25519' | 'zklogin';
export type OAuthProvider = 'google' | 'apple';

export interface AuthProvider {
  mode: AuthMode;
  getAddress(): Promise<string>;
  getDID(): string;
  signTransaction(tx: Uint8Array): Promise<Uint8Array>;
  signPersonalMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  isAuthenticated(): boolean;
  getPublicKey(): Uint8Array;
  toSuiSigner(): Signer;
  getSessionState?(): SessionState;
  isSessionValid?(): boolean | Promise<boolean>;
  onSessionStateChange?(callback: SessionStateChangeCallback): () => void;
}

export interface ZkLoginSession {
  provider: OAuthProvider;
  jwt: string;
  salt: string;
  epoch: number;
  ephemeralKeypair: Ed25519Keypair;
  proof: ZkLoginProof;
  maxEpoch: number;
  address: string;
  sub: string;
  iss: string;
  aud: string;
}

export interface StoredZkLoginSession extends ZkLoginSession {
  randomness: string;
  refreshToken?: string;
  createdAt: number;
  updatedAt: number;
  sessionState?: SessionState;
  refreshFailureCount?: number;
}

export interface ZkLoginProof {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
  addressSeed: string;
}

export interface OAuthConfig {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceCodeEndpoint?: string;
  saltEndpoint?: string;
  proverEndpoint?: string;
  issuer?: string;
  scopes?: string[];
}

export interface OAuthTokenResponse {
  jwt: string;
  refreshToken?: string;
  accessToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

export interface DeviceFlowStatus {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  pollInterval: number;
  expiresIn: number;
}
