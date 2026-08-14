package handler

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"example.com/pokedex/repository"
	"example.com/pokedex/service"
)

func newTestHandler() *Handler {
	return NewHandler(service.NewService(repository.NewRepository()))
}

func Test_addPokemon(t *testing.T) {
	h := newTestHandler()
	body := bytes.NewBufferString(`{"name":"pikachu","type":"electric","power":55}`)
	req := httptest.NewRequest(http.MethodPost, "/pokemon", body)
	rec := httptest.NewRecorder()

	addPokemon(h, rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected %d, got %d", http.StatusCreated, rec.Code)
	}
}

func Test_addPokemon_rejectsOverpowered(t *testing.T) {
	h := newTestHandler()
	body := bytes.NewBufferString(`{"name":"mewtwo","type":"psychic","power":5000}`)
	req := httptest.NewRequest(http.MethodPost, "/pokemon", body)
	rec := httptest.NewRecorder()

	addPokemon(h, rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected %d, got %d", http.StatusUnprocessableEntity, rec.Code)
	}
}

func Test_listPokemon(t *testing.T) {
	h := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "/pokemon", nil)
	rec := httptest.NewRecorder()

	listPokemon(h, rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected %d, got %d", http.StatusOK, rec.Code)
	}
}
