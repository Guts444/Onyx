declare const epgOperationTokenBrand: unique symbol;
declare const epgBusyStateBrand: unique symbol;

const tokenIdentities = new WeakMap<EpgOperationToken, symbol>();
const busyIdentities = new WeakMap<EpgSourceBusyState, symbol>();

export interface EpgOperationToken {
  readonly [epgOperationTokenBrand]: true;
  readonly sourceId: string;
  readonly configRevision: string;
  readonly generation: number;
  isCurrent(): boolean;
}

export interface EpgSourceCommitState {
  sourceId: string;
  configRevision: string;
  exists: boolean;
}

export interface EpgSourceBusyState {
  readonly [epgBusyStateBrand]: true;
  readonly sourceId: string;
  readonly generation: number;
}

interface EpgRefreshIdentitySource {
  id: string;
  updatedAt: string;
  updateOnStartup: boolean;
  autoUpdateEnabled: boolean;
  updateIntervalHours: number;
}

export function getEpgStartupIdentity(source: EpgRefreshIdentitySource) {
  return `${source.id}\u0001${source.updatedAt}\u0001${source.updateOnStartup ? "enabled" : "disabled"}`;
}

export function getEpgAutoUpdateIdentity(source: EpgRefreshIdentitySource) {
  return `${source.id}\u0001${source.updatedAt}\u0001${source.autoUpdateEnabled ? "enabled" : "disabled"}\u0001${
    source.autoUpdateEnabled ? source.updateIntervalHours : 0
  }`;
}

interface EpgSourceLike { id: string; updatedAt: string; }

export function createEpgOperationCoordinator() {
  let generation = 0;
  const currentBySource = new Map<string, EpgOperationToken>();
  const isCurrent = (token: EpgOperationToken) => currentBySource.get(token.sourceId) === token;
  return {
    start(sourceId: string, configRevision: string) {
      generation += 1;
      const token = {
        sourceId, configRevision, generation,
        isCurrent: () => isCurrent(token),
      } as EpgOperationToken;
      tokenIdentities.set(token, Symbol("epg-operation-identity"));
      Object.freeze(token);
      currentBySource.set(sourceId, token);
      return token;
    },
    invalidate(sourceId: string) { generation += 1; currentBySource.delete(sourceId); },
    isCurrent,
    canCommit(token: EpgOperationToken, state: EpgSourceCommitState) {
      return isCurrent(token) && state.exists && state.sourceId === token.sourceId &&
        state.configRevision === token.configRevision;
    },
  };
}

export function getEpgSourceCommitState(
  sources: EpgSourceLike[],
  sourceId: string,
  configRevision: string,
): EpgSourceCommitState {
  const source = sources.find((candidate) => candidate.id === sourceId);
  return { sourceId, configRevision: source?.updatedAt ?? configRevision, exists: source !== undefined };
}

export function beginEpgSourceOperation(token: EpgOperationToken): EpgSourceBusyState {
  const identity = tokenIdentities.get(token);
  if (!identity) throw new TypeError("EPG operation token was not issued by a coordinator");
  const busy = { sourceId: token.sourceId, generation: token.generation } as EpgSourceBusyState;
  busyIdentities.set(busy, identity);
  return Object.freeze(busy);
}

export function finishEpgSourceOperation(
  current: EpgSourceBusyState | null,
  token: EpgOperationToken,
): EpgSourceBusyState | null {
  if (!current) return null;
  return busyIdentities.get(current) === tokenIdentities.get(token) ? null : current;
}
