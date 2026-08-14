package helpers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// Pokemon is the transport representation of a pokemon.
type Pokemon struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Power int    `json:"power"`
}

// ErrEmptyName is returned when a payload has no name.
var ErrEmptyName = errors.New("pokemon name must not be empty")

// DecodePokemonJSON reads a Pokemon from an request body.
func DecodePokemonJSON(body io.Reader) (Pokemon, error) {
	var p Pokemon
	if err := json.NewDecoder(body).Decode(&p); err != nil {
		return Pokemon{}, err
	}
	if p.Name == "" {
		return Pokemon{}, ErrEmptyName
	}
	return p, nil
}

// RespondWithError writes a JSON error body.
func RespondWithError(w http.ResponseWriter, code int, err error) {
	RespondWithJSON(w, code, map[string]string{"error": err.Error()})
}

// RespondWithJSON writes any payload as JSON.
func RespondWithJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}
