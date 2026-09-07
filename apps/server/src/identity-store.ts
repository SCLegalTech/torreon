import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { emptyIdentity, type IdentityState } from "./identity.js";

/**
 * DÓNDE VIVEN LAS LLAVES.
 *
 * Un documento aparte del reino, a propósito: la identidad no es del reino de
 * nadie —es de TODOS los jugadores— y un `reset` del reino no puede dejar a
 * alguien fuera de su propia partida.
 *
 * Escritura atómica y una cola, igual que el reino. Cuando el reino se mude a
 * SQLite (ADR-0003), esto se muda con él; hasta entonces comparte disciplina.
 *
 * Lo que hay dentro son HUELLAS, nunca secretos: ni una copia de este archivo
 * entrega la llave de nadie.
 */
export class IdentityStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly clock: Clock = systemClock,
  ) {}

  static beside(statePath: string, clock: Clock = systemClock): IdentityStore {
    return new IdentityStore(resolve(dirname(statePath), "identity.json"), clock);
  }

  async read(): Promise<IdentityState> {
    try {
      const raw = await readFile(this.path, "utf8");
      const state = JSON.parse(raw) as IdentityState;
      state.players ??= [];
      state.sessions ??= [];
      state.grants ??= [];
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyIdentity();
    }
  }

  async mutate<T>(mutation: (identity: IdentityState) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const identity = await this.read();
      const result = mutation(identity);
      await this.write(identity);
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async write(identity: IdentityState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    await rename(tempPath, this.path);
    void this.clock;
  }
}
