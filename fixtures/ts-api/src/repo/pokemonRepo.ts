import type { Pokemon } from '../lib/http.js';

export class PokemonRepo {
  private rows: Pokemon[] = [];

  insert(p: Pokemon): void {
    this.rows.push(p);
  }

  list(): Pokemon[] {
    return [...this.rows];
  }
}
