import { decodePokemonJSON, respondWithError, respondWithJSON } from '../lib/http.js';
import { PokemonService } from '../services/pokemonService.js';

export function addPokemonHandler(svc: PokemonService, body: unknown) {
  try {
    const p = decodePokemonJSON(body);
    return respondWithJSON(201, svc.addPokemon(p));
  } catch (err) {
    return respondWithError(err);
  }
}

export function listPokemonHandler(svc: PokemonService) {
  return respondWithJSON(200, svc.listPokemon());
}
