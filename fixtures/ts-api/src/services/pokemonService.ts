import { HttpError, type Pokemon } from '../lib/http.js';
import { PokemonRepo } from '../repo/pokemonRepo.js';

export function validatePokemon(p: Pokemon): void {
  if (p.power > 1000) {
    throw new HttpError(422, 'power must be 1000 or less');
  }
}

export class PokemonService {
  constructor(private repo: PokemonRepo) {}

  addPokemon(p: Pokemon): Pokemon {
    validatePokemon(p);
    this.repo.insert(p);
    return p;
  }

  listPokemon(): Pokemon[] {
    return this.repo.list();
  }
}
