declare const sourceMutationTokenBrand: unique symbol;

export interface SourceMutationToken {
  readonly [sourceMutationTokenBrand]: true;
  readonly sourceId: string;
}

export interface SourceMutationCoordinator<TSource extends object> {
  begin(sourceId: string, source: TSource): SourceMutationToken;
  canCommit(token: SourceMutationToken, currentSource: TSource | undefined): boolean;
  invalidate(sourceId: string): void;
}

export function createSourceMutationCoordinator<
  TSource extends object,
>(): SourceMutationCoordinator<TSource> {
  const currentBySourceId = new Map<string, SourceMutationToken>();
  const expectedSourceIdentities = new WeakMap<SourceMutationToken, TSource>();

  return {
    begin(sourceId, source) {
      const token = Object.freeze({ sourceId }) as SourceMutationToken;
      expectedSourceIdentities.set(token, source);
      currentBySourceId.set(sourceId, token);
      return token;
    },
    canCommit(token, currentSource) {
      return (
        currentSource !== undefined &&
        currentBySourceId.get(token.sourceId) === token &&
        expectedSourceIdentities.get(token) === currentSource
      );
    },
    invalidate(sourceId) {
      currentBySourceId.delete(sourceId);
    },
  };
}
