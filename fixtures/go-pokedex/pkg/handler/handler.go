package handler

import (
	"net/http"

	"example.com/pokedex/service"
)

// Handler holds the http dependencies.
type Handler struct {
	svc *service.Service
}

// NewHandler builds a Handler.
func NewHandler(svc *service.Service) *Handler {
	return &Handler{svc: svc}
}

// Routes registers every pokedex route.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/pokemon", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			addPokemon(h, w, r)
		default:
			listPokemon(h, w, r)
		}
	})
}
