package handler

import (
	"net/http"

	"example.com/pokedex/helpers"
	"example.com/pokedex/service"
)

// addPokemon handles POST /pokemon.
func addPokemon(h *Handler, w http.ResponseWriter, r *http.Request) {
	p, err := helpers.DecodePokemonJSON(r.Body)
	if err != nil {
		helpers.RespondWithError(w, http.StatusBadRequest, err)
		return
	}
	if err := service.AddPokemon(h.svc, p); err != nil {
		helpers.RespondWithError(w, http.StatusUnprocessableEntity, err)
		return
	}
	helpers.RespondWithJSON(w, http.StatusCreated, p)
}

// listPokemon handles GET /pokemon.
func listPokemon(h *Handler, w http.ResponseWriter, r *http.Request) {
	helpers.RespondWithJSON(w, http.StatusOK, service.ListPokemon(h.svc))
}
