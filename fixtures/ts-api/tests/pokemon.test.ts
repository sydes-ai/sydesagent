import { describe, it, expect } from 'vitest';
import { addPokemonHandler } from '../src/handlers/pokemon.js';
import { PokemonService, validatePokemon } from '../src/services/pokemonService.js';
import { PokemonRepo } from '../src/repo/pokemonRepo.js';

describe('addPokemonHandler', () => {
  it('creates a pokemon', () => {
    const svc = new PokemonService(new PokemonRepo());
    const res = addPokemonHandler(svc, { name: 'pikachu', type: 'electric', power: 55 });
    expect(res.status).toBe(201);
  });

  it('rejects overpowered pokemon', () => {
    const svc = new PokemonService(new PokemonRepo());
    const res = addPokemonHandler(svc, { name: 'mewtwo', type: 'psychic', power: 5000 });
    expect(res.status).toBe(422);
  });
});

describe('validatePokemon', () => {
  it('accepts a normal pokemon', () => {
    expect(() => validatePokemon({ name: 'onix', type: 'rock', power: 10 })).not.toThrow();
  });
});
