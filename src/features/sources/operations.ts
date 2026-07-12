export type SourceOperationOrigin = "local" | "saved" | "startup";

export interface SourceOperationRequest {
  origin: SourceOperationOrigin;
  sourceId: string | null;
  expectedFingerprint: string | null;
}

export interface SourceOperationToken extends Readonly<SourceOperationRequest> {
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
  readonly generation: number;
  readonly origin: SourceOperationOrigin;
  readonly sourceId: string | null;
}

export function beginSourceBusy(token: SourceOperationToken): SourceBusyState {
  return {
    generation: token.generation,
    origin: token.origin,
    sourceId: token.sourceId,
  };
}

export function finishSourceBusy(
  current: SourceBusyState | null,
  token: SourceOperationToken,
): SourceBusyState | null {
  return current?.generation === token.generation ? null : current;
}

export function createSourceOperationCoordinator(): SourceOperationCoordinator {
  let generation = 0;
  let currentToken: SourceOperationToken | null = null;

  const isCurrent = (token: SourceOperationToken) => token === currentToken;

  return {
    start(request) {
      generation += 1;
      const token: SourceOperationToken = {
        ...request,
        generation,
        isCurrent: () => isCurrent(token),
      };
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
