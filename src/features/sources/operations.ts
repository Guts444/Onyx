export type SourceOperationOrigin = "local" | "saved" | "startup";

declare const sourceOperationTokenBrand: unique symbol;
declare const sourceBusyStateBrand: unique symbol;
const tokenIdentities = new WeakMap<SourceOperationToken, symbol>();
const busyIdentities = new WeakMap<SourceBusyState, symbol>();

export interface SourceOperationRequest {
  origin: SourceOperationOrigin;
  sourceId: string | null;
  expectedFingerprint: string | null;
}

export interface SourceOperationToken extends Readonly<SourceOperationRequest> {
  readonly [sourceOperationTokenBrand]: true;
  readonly generation: number;
  isCurrent(): boolean;
}

export interface SourceOperationCommitState {
  sourceId: string | null;
  fingerprint: string | null;
  exists: boolean;
  ready: boolean;
}

export interface SourceOperationCoordinator {
  start(request: SourceOperationRequest): SourceOperationToken;
  isCurrent(token: SourceOperationToken): boolean;
  canCommit(token: SourceOperationToken, state: SourceOperationCommitState): boolean;
  invalidateSource(sourceId: string): void;
}

export interface SourceBusyState {
  readonly [sourceBusyStateBrand]: true;
  readonly generation: number;
  readonly origin: SourceOperationOrigin;
  readonly sourceId: string | null;
}

export function beginSourceBusy(token: SourceOperationToken): SourceBusyState {
  const identity = tokenIdentities.get(token);
  if (!identity) {
    throw new TypeError("Source operation token was not issued by a coordinator");
  }

  const busy = {
    generation: token.generation,
    origin: token.origin,
    sourceId: token.sourceId,
  } as SourceBusyState;
  busyIdentities.set(busy, identity);
  return Object.freeze(busy);
}

export function finishSourceBusy(
  current: SourceBusyState | null,
  token: SourceOperationToken,
): SourceBusyState | null {
  if (!current) {
    return null;
  }

  const busyIdentity = busyIdentities.get(current);
  const tokenIdentity = tokenIdentities.get(token);
  return busyIdentity !== undefined && busyIdentity === tokenIdentity ? null : current;
}

export function createSourceOperationCoordinator(): SourceOperationCoordinator {
  let generation = 0;
  let currentToken: SourceOperationToken | null = null;

  const isCurrent = (token: SourceOperationToken) => token === currentToken;

  return {
    start(request) {
      generation += 1;
      const token = {
        ...request,
        generation,
        isCurrent: () => isCurrent(token),
      } as SourceOperationToken;
      tokenIdentities.set(token, Symbol("source-operation-identity"));
      Object.freeze(token);
      currentToken = token;
      return token;
    },
    isCurrent,
    canCommit(token, state) {
      return (
        isCurrent(token) &&
        token.sourceId === state.sourceId &&
        token.expectedFingerprint === state.fingerprint &&
        state.exists &&
        state.ready
      );
    },
    invalidateSource(sourceId) {
      if (currentToken?.sourceId === sourceId) {
        generation += 1;
        currentToken = null;
      }
    },
  };
}
