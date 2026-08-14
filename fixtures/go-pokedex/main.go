package main

import (
	"log"
	"net/http"

	"example.com/pokedex/pkg/handler"
	"example.com/pokedex/repository"
	"example.com/pokedex/service"
)

func main() {
	svc := service.NewService(repository.NewRepository())
	h := handler.NewHandler(svc)

	mux := http.NewServeMux()
	h.Routes(mux)

	log.Println("listening on :8080")
	if err := http.ListenAndServe(":8080", mux); err != nil {
		log.Fatal(err)
	}
}
