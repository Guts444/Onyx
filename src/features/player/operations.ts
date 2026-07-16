export interface PlaybackOperationToken {
  readonly revision: number;
  isCurrent(): boolean;
}

export function commitIfCurrentPlaybackRevision(
  revision: number,
  currentRevision: () => number,
  commit: () => void,
) {
  if (currentRevision() !== revision) return false;
  commit();
  return true;
}

export class LatestPlaybackOperationCoordinator {
  private revision = 0;
  private queue: Promise<void> = Promise.resolve();

  begin(externalGuard: () => boolean = () => true): PlaybackOperationToken {
    const revision = ++this.revision;
    return {
      revision,
      isCurrent: () => this.revision === revision && externalGuard(),
    };
  }

  invalidate() {
    this.revision += 1;
  }

  run<T>(token: PlaybackOperationToken, action: () => Promise<T>): Promise<T | null> {
    const result = this.queue
      .catch(() => undefined)
      .then(async () => {
        if (!token.isCurrent()) return null;
        const value = await action();
        return token.isCurrent() ? value : null;
      });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
