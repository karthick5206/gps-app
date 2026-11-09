/** Bounded set of recently seen ids (insertion order; the oldest is evicted past `capacity`). */
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity: number) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    if (this.ids.size > this.capacity) this.ids.delete(this.ids.values().next().value as string);
  }

  get size(): number {
    return this.ids.size;
  }
}
