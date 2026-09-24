/**
 * A single monotonic id space shared by terminal and SFTP sessions, so they
 * never collide. Mirrors `SessionRegistry` in state.rs.
 */
export class SessionRegistry {
  private next = 1;

  allocate(): number {
    return this.next++;
  }
}
