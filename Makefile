.PHONY: help serve stop restart open backend backend-stop setup download dev \
       db-up db-down db-import db-reset db-shell

.DEFAULT_GOAL := help

# Show all available commands
help:
	@echo "Circle Triangulation — available commands:"
	@echo ""
	@echo "  make dev            Start DB + frontend + backend, open browser"
	@echo "  make serve          Start frontend server (port $(PORT))"
	@echo "  make serve-bg       Start frontend in background"
	@echo "  make backend        Start backend API (port $(API_PORT))"
	@echo "  make backend-bg     Start backend in background"
	@echo "  make restart        Restart both frontend and backend"
	@echo "  make stop           Stop frontend + backend (DB keeps running)"
	@echo "  make open           Open app in default browser"
	@echo ""
	@echo "  make setup          Create Python venv and install dependencies"
	@echo "  make download       Download population rasters (all countries)"
	@echo '  make download COUNTRIES="USA BRA"  Download specific countries'
	@echo ""
	@echo "  make db-up          Start PostgreSQL (Docker)"
	@echo "  make db-down        Stop PostgreSQL"
	@echo "  make db-import      Download + import OSM data (DC/MD/VA)"
	@echo "  make db-reset       Wipe DB and re-import from scratch"
	@echo "  make db-shell       Open psql shell"
	@echo ""
	@echo "Quick start:"
	@echo "  make setup && make db-up && make db-import && make dev"

PORT ?= 8080
API_PORT ?= 8081
VENV = backend/.venv

# --- Frontend ---

# Start the local dev server
serve:
	@echo "Starting frontend at http://localhost:$(PORT)"
	@echo "Press Ctrl+C to stop"
	python3 -m http.server $(PORT)

# Start in the background
serve-bg:
	@echo "Starting frontend in background at http://localhost:$(PORT)"
	@python3 -m http.server $(PORT) &>/dev/null &
	@echo "PID: $$!"

# Stop any background server on this port
stop:
	@lsof -ti :$(PORT) | xargs kill 2>/dev/null && echo "Frontend stopped" || echo "No frontend on port $(PORT)"
	@lsof -ti :$(API_PORT) | xargs kill 2>/dev/null && echo "Backend stopped" || echo "No backend on port $(API_PORT)"

# Restart both servers
restart: stop
	@sleep 1
	@$(MAKE) serve-bg backend-bg
	@echo "Restarted. Frontend: http://localhost:$(PORT)  Backend: http://localhost:$(API_PORT)"

# Open in default browser
open:
	open http://localhost:$(PORT)

# --- Backend ---

# Create virtualenv and install dependencies
setup:
	@echo "Setting up Python virtualenv..."
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -r backend/requirements.txt
	@echo "Done. Run 'make download' to fetch population data."

# Download population rasters (pass COUNTRIES="USA CAN" to filter)
download:
	@echo "Downloading population data..."
	cd backend && .venv/bin/python download.py $(COUNTRIES)

# Start the backend API server
backend:
	@echo "Starting backend API at http://localhost:$(API_PORT)"
	@echo "Press Ctrl+C to stop"
	cd backend && .venv/bin/uvicorn app:app --host 0.0.0.0 --port $(API_PORT) --reload

# Start backend in background
backend-bg:
	@echo "Starting backend in background at http://localhost:$(API_PORT)"
	@cd backend && .venv/bin/uvicorn app:app --host 0.0.0.0 --port $(API_PORT) &>/dev/null &

# --- Database ---

# Start PostgreSQL with PostGIS + pgRouting
db-up:
	@docker compose up -d
	@echo "Waiting for database to be ready..."
	@until docker compose exec -T db pg_isready -U ct -d circle_tri >/dev/null 2>&1; do sleep 1; done
	@echo "Database ready at localhost:5432"

# Stop PostgreSQL
db-down:
	@docker compose down

# Download Geofabrik OSM extracts and import into PostGIS
db-import:
	cd backend && .venv/bin/python import_osm.py

# Wipe database and re-import
db-reset:
	docker compose down -v
	@$(MAKE) db-up
	@$(MAKE) db-import

# Open psql shell
db-shell:
	docker compose exec db psql -U ct -d circle_tri

# --- Full dev environment ---

# Start DB + frontend + backend, open browser
dev: db-up serve-bg backend-bg
	@sleep 1
	@open http://localhost:$(PORT)
	@echo "Frontend: http://localhost:$(PORT)"
	@echo "Backend:  http://localhost:$(API_PORT)"
	@echo "Database: localhost:5432"
	@echo "Use 'make stop' to shut down frontend + backend."
	@echo "Use 'make db-down' to stop the database."
