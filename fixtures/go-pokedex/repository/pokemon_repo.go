package repository

import (
	"sync"

	"example.com/pokedex/helpers"
)

// Repository stores pokemon in memory.
type Repository struct {
	mu   sync.Mutex
	rows []helpers.Pokemon
}

// NewRepository builds an empty repository.
func NewRepository() *Repository {
	return &Repository{rows: []helpers.Pokemon{}}
}

// Insert appends a pokemon row.
func (r *Repository) Insert(p helpers.Pokemon) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rows = append(r.rows, p)
	return nil
}

// List returns every stored pokemon.
func (r *Repository) List() []helpers.Pokemon {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]helpers.Pokemon, len(r.rows))
	copy(out, r.rows)
	return out
}
