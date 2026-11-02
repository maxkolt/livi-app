import mongoose from 'mongoose';
import { getFriendIdsForUsers } from './friendshipUtils';

type ReadFriends = (ids: string[]) => Promise<Map<string, string[]>>;
type Waiting = { resolve: (ids: readonly string[]) => void; reject: (error: unknown) => void };

/** Small concurrent reads share a bounded query batch. No result survives its
 * batch: a later friendship change always gets an authoritative database read. */
export class FriendPresenceRecipients {
  private pending = new Map<string, Waiting[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = 0;

  constructor(private read: ReadFriends, private batchSize = 128, private concurrency = 4) {}

  load(userId: string): Promise<readonly string[]> {
    if (!mongoose.Types.ObjectId.isValid(userId)) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const waiting = this.pending.get(userId) || [];
      waiting.push({ resolve, reject });
      this.pending.set(userId, waiting);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer || this.active >= this.concurrency || !this.pending.size) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 2);
  }

  private flush(): void {
    while (this.active < this.concurrency && this.pending.size) {
      const batch = new Map<string, Waiting[]>();
      for (const [id, waiting] of this.pending) {
        batch.set(id, waiting);
        this.pending.delete(id);
        if (batch.size === this.batchSize) break;
      }
      this.active++;
      void Promise.resolve().then(() => this.read([...batch.keys()])).then((result) => {
        for (const [id, waiting] of batch) for (const request of waiting) request.resolve(result.get(id) || []);
      }, (error) => {
        for (const waiting of batch.values()) for (const request of waiting) request.reject(error);
      }).finally(() => { this.active--; this.schedule(); });
    }
  }
}

const recipients = new FriendPresenceRecipients(getFriendIdsForUsers);
export const getPresenceFriendIds = (userId: string): Promise<readonly string[]> => recipients.load(userId);
