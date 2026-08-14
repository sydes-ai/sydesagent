import { addPokemonHandler, listPokemonHandler } from '../handlers/pokemon.js';
import { PokemonService } from '../services/pokemonService.js';

export interface Route {
  method: string;
  path: string;
  handle: (body: unknown) => unknown;
}

export function pokemonRoutes(svc: PokemonService): Route[] {
  return [
    { method: 'POST', path: '/pokemon', handle: (body) => addPokemonHandler(svc, body) },
    { method: 'GET', path: '/pokemon', handle: () => listPokemonHandler(svc) },
  ];
}
