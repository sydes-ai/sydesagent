package service

import (
	"testing"

	"example.com/pokedex/helpers"
	"example.com/pokedex/repository"
)

func Test_ValidatePokemon(t *testing.T) {
	if err := ValidatePokemon(helpers.Pokemon{Name: "onix", Power: 10}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := ValidatePokemon(helpers.Pokemon{Name: "mewtwo", Power: 9000}); err == nil {
		t.Fatal("expected an error for overpowered pokemon")
	}
}

func Test_AddPokemon(t *testing.T) {
	svc := NewService(repository.NewRepository())
	if err := AddPokemon(svc, helpers.Pokemon{Name: "bulbasaur", Power: 12}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := len(ListPokemon(svc)); got != 1 {
		t.Fatalf("expected 1 stored pokemon, got %d", got)
	}
}
