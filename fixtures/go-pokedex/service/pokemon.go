package service

import (
	"errors"

	"example.com/pokedex/helpers"
	"example.com/pokedex/repository"
)

// ErrPowerTooHigh rejects overpowered pokemon.
var ErrPowerTooHigh = errors.New("power must be 1000 or less")

// Service owns pokemon business rules.
type Service struct {
	repo *repository.Repository
}

// NewService wires a service to a repository.
func NewService(repo *repository.Repository) *Service {
	return &Service{repo: repo}
}

// AddPokemon validates and stores a pokemon.
func AddPokemon(s *Service, p helpers.Pokemon) error {
	if err := ValidatePokemon(p); err != nil {
		return err
	}
	return s.repo.Insert(p)
}

// ValidatePokemon enforces the business rules for a pokemon.
func ValidatePokemon(p helpers.Pokemon) error {
	if p.Power > 1000 {
		return ErrPowerTooHigh
	}
	return nil
}

// ListPokemon returns everything stored.
func ListPokemon(s *Service) []helpers.Pokemon {
	return s.repo.List()
}
